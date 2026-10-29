package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/settings"
)

type forkTransport struct {
	base string
	t    *testing.T
}

func (f forkTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "api.github.com" && r.URL.Host != "github.com" {
		f.t.Fatalf("unexpected external request: %s", r.URL)
	}
	if !strings.HasPrefix(r.URL.Path, "/repos/lingqiqi5211/moepie/releases") && !strings.HasPrefix(r.URL.Path, "/lingqiqi5211/moepie/releases/") {
		f.t.Fatalf("request escaped fork: %s", r.URL)
	}
	clone := r.Clone(r.Context())
	u := *r.URL
	clone.URL = &u
	clone.URL.Scheme = "http"
	clone.URL.Host = strings.TrimPrefix(f.base, "http://")
	return http.DefaultTransport.RoundTrip(clone)
}

func TestForkReleasesAndNotes(t *testing.T) {
	t.Setenv("MAGPIE_UPDATE_FEED", "")
	t.Setenv("MAGPIE_NOTES_FEED", "")
	stableFor(t, "")
	const sumsURL = "https://github.com/lingqiqi5211/moepie/releases/download/v0.1.2000/SHA256SUMS"
	const binaryURL = "https://github.com/lingqiqi5211/moepie/releases/download/v0.1.2000/moepie-cli-linux-amd64"
	missing := false
	latest := map[string]any{"tag_name": "v0.1.2000", "body": twoNotes, "html_url": ReleasePage("0.1.2000"), "published_at": time.Now().Add(-time.Hour), "assets": []map[string]any{
		{"name": "SHA256SUMS", "browser_download_url": sumsURL},
		{"name": "moepie-cli-linux-amd64", "browser_download_url": binaryURL, "size": 42},
	}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/SHA256SUMS"):
			fmt.Fprintf(w, "%s  moepie-cli-linux-amd64\n", strings.Repeat("a", 64))
		case strings.HasSuffix(r.URL.Path, "/latest"):
			if missing {
				copy := map[string]any{}
				for k, v := range latest {
					copy[k] = v
				}
				copy["assets"] = []any{}
				json.NewEncoder(w).Encode(copy)
			} else {
				json.NewEncoder(w).Encode(latest)
			}
		default:
			json.NewEncoder(w).Encode([]any{latest, map[string]any{"tag_name": "v0.1.1999", "body": "- earlier", "published_at": time.Now().AddDate(0, 0, -14)}})
		}
	}))
	defer srv.Close()
	before := client
	client = &http.Client{Transport: forkTransport{srv.URL, t}}
	t.Cleanup(func() { client = before })
	r, err := LatestIn(context.Background(), "zh")
	if err != nil {
		t.Fatal(err)
	}
	if r.Version != "0.1.2000" || r.Notes != zhNotes || r.Assets["moepie-cli-linux-amd64"].SHA256 != strings.Repeat("a", 64) || r.Assets["moepie-cli-linux-amd64"].URL != binaryURL {
		t.Fatalf("unexpected fork release: %+v", r)
	}
	notes, err := NotesBack(context.Background(), "0.1.2000", 10, "zh")
	if err != nil || len(notes) != 2 || notes[0].Notes != zhNotes {
		t.Fatalf("notes: %+v, %v", notes, err)
	}
	stableFor(t, settings.UpdateStable)
	r, err = Latest(context.Background())
	// The older weekly choice has no manifest: it must fail rather than
	// install today's version merely because Stable has no older checksum.
	if err == nil || !strings.Contains(err.Error(), "missing SHA256SUMS") {
		t.Fatalf("stable unexpectedly chose latest: %+v %v", r, err)
	}
	stableFor(t, "")
	missing = true
	if _, err := Latest(context.Background()); err == nil || !strings.Contains(err.Error(), "missing SHA256SUMS") {
		t.Fatalf("missing checksum accepted: %v", err)
	}
}

type forkRoundTrip func(*http.Request) (*http.Response, error)

func (f forkRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Metadata and its checksums are the trust anchor, not mirrorable files.
func TestForkTrustAnchorNeverUsesMirrors(t *testing.T) {
	t.Setenv("MAGPIE_MIRRORS", "on")
	t.Setenv("MAGPIE_GITHUB_MIRROR", "https://untrusted.example")
	for _, kind := range []string{"metadata", "checksums"} {
		t.Run(kind, func(t *testing.T) {
			before := client
			calls := 0
			client = &http.Client{Transport: forkRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Host != "api.github.com" && r.URL.Host != "github.com" {
					t.Errorf("trust anchor requested from mirror: %s", r.URL)
				}
				return &http.Response{StatusCode: 503, Status: "503 unavailable", Body: io.NopCloser(strings.NewReader("unavailable")), Header: http.Header{}, Request: r}, nil
			})}
			t.Cleanup(func() { client = before })
			var err error
			if kind == "metadata" {
				var r githubRelease
				err = githubGet(context.Background(), releaseAPI+"/latest", &r)
			} else {
				r := githubRelease{Tag: "v0.1.2000"}
				r.Assets = append(r.Assets, struct {
					Name string `json:"name"`
					URL  string `json:"browser_download_url"`
					Size int64  `json:"size"`
				}{Name: "SHA256SUMS", URL: Site + "/download/v0.1.2000/SHA256SUMS"})
				_, err = githubManifest(context.Background(), r, "")
			}
			if err == nil || calls != 1 {
				t.Fatalf("%s: error %v, %d requests, want official failure alone", kind, err, calls)
			}
		})
	}
}

// GitHub's creation order can put a newer version on a later page: enough
// notes or an old-enough Stable candidate on page one is not a stopping rule.
func TestForkHistoryScansBeforeSelecting(t *testing.T) {
	t.Setenv("MAGPIE_UPDATE_FEED", "")
	t.Setenv("MAGPIE_NOTES_FEED", "")
	stableFor(t, "")
	pages := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/SHA256SUMS") {
			fmt.Fprintf(w, "%s  %s\n", strings.Repeat("a", 64), BinaryAsset())
			return
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		pages++
		var batch []map[string]any
		// First page has versions 100..1; page two has 201..101.
		start, count := 100, 100
		if page == 2 {
			start, count = 201, 100
		} else if page == 3 {
			start, count = 101, 1
		}
		for i := range count {
			v := fmt.Sprintf("0.1.%d", start-i)
			batch = append(batch, map[string]any{"tag_name": "v" + v, "body": "notes " + v, "published_at": time.Now().AddDate(0, 0, -30), "assets": []map[string]any{
				{"name": "SHA256SUMS", "browser_download_url": Site + "/download/v" + v + "/SHA256SUMS"},
				{"name": BinaryAsset(), "browser_download_url": Site + "/download/v" + v + "/" + BinaryAsset()},
			}})
		}
		json.NewEncoder(w).Encode(batch)
	}))
	defer srv.Close()
	before := client
	client = &http.Client{Transport: forkTransport{srv.URL, t}}
	t.Cleanup(func() { client = before })
	for _, n := range []int{50, 100} {
		pages = 0
		notes, err := NotesBack(context.Background(), "0.1.201", n, "")
		if err != nil || len(notes) != n+1 || notes[0].Version != "0.1.201" || notes[n].Version != fmt.Sprintf("0.1.%d", 201-n) || pages != 3 {
			t.Fatalf("back %d: %d notes, %d pages, %v: %+v", n, len(notes), pages, err, notes)
		}
	}
	stableFor(t, settings.UpdateStable)
	pages = 0
	rel, err := Latest(context.Background())
	if err != nil || rel.Version != "0.1.201" || pages != 3 {
		t.Fatalf("Stable: %+v, %d pages, %v", rel, pages, err)
	}
}
