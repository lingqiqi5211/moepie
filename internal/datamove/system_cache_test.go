package datamove

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/yetone/magpie/internal/appdir"
)

func TestSystemCacheBothDirections(t *testing.T) {
	for _, distinct := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared", true: "distinct"}[distinct], func(t *testing.T) {
			e := exe(t)
			if !distinct {
				cache, err := os.UserCacheDir()
				if err != nil {
					t.Fatal(err)
				}
				t.Setenv("XDG_CACHE_HOME", cache)
			}
			if distinct {
				t.Setenv("XDG_CACHE_HOME", filepath.Join(os.Getenv("HOME"), "other-cache"))
				if runtime.GOOS == "linux" {
					t.Skip("Linux UserCacheDir and InstalledCache both follow XDG_CACHE_HOME; distinct mapping covered on Windows")
				}
			}
			src, err := PlacesOf(e, appdir.ModeInstalled)
			if err != nil {
				t.Fatal(err)
			}
			write(t, filepath.Join(src.Config, "settings.json"), "settings")
			write(t, filepath.Join(src.Cache, "same.json"), "regular")
			shared := appdir.SameCachePath(src.Cache, src.SystemCache)
			if !shared {
				write(t, filepath.Join(src.SystemCache, "same.json"), "system")
			}
			ps, err := Pairs(e, appdir.ModeInstalled, appdir.ModePortable)
			if err != nil {
				t.Fatal(err)
			}
			want := 2
			if !shared {
				want++
			}
			if runtime.GOOS == "windows" {
				want++
			}
			if len(ps) != want {
				t.Fatal(ps)
			}
			if err := runMove(t, e, appdir.ModeInstalled, appdir.ModePortable); err != nil {
				t.Fatal(err)
			}
			dst, _ := PlacesOf(e, appdir.ModePortable)
			if read(t, filepath.Join(dst.Cache, "same.json")) != "regular" {
				t.Fatal("cache overwritten")
			}
			if !shared && read(t, filepath.Join(dst.SystemCache, "same.json")) != "system" {
				t.Fatal("system cache overwritten")
			}
			if exists(filepath.Join(src.Cache, "same.json")) || exists(filepath.Join(src.SystemCache, "same.json")) {
				t.Fatal("source cache remains")
			}
			if err := runMove(t, e, appdir.ModePortable, appdir.ModeInstalled); err != nil {
				t.Fatal(err)
			}
			if read(t, filepath.Join(src.Cache, "same.json")) != "regular" {
				t.Fatal("reverse cache")
			}
			if !shared && read(t, filepath.Join(src.SystemCache, "same.json")) != "system" {
				t.Fatal("reverse system cache")
			}
		})
	}
}
