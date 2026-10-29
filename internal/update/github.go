package update

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/yetone/magpie/internal/source"
)

// githubRelease is GitHub's wire format. The custom feed overrides keep
// their original Release/Note formats, so existing local test feeds work.
type githubRelease struct {
	Tag        string    `json:"tag_name"`
	Body       string    `json:"body"`
	URL        string    `json:"html_url"`
	Published  time.Time `json:"published_at"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

var urgentNotes = regexp.MustCompile(`(?im)^[ \t]*(?:>[ \t]*)?\*\*urgent release:\*\*`)

func githubGet(ctx context.Context, address string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "moepie-updater")
	res, err := source.DoOfficial(client, req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("fork releases: %s", res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 16<<20)).Decode(out)
}

func (r githubRelease) version() string { return strings.TrimPrefix(r.Tag, "v") }
func (r githubRelease) usable() bool {
	return !r.Draft && !r.Prerelease && parse(r.version()) != nil
}

// githubList visits at most the same 1500 releases the Stable history
// allows. GitHub orders by creation, not version or publication time: scan
// the whole budget before selecting a version, even after enough matches.
func githubList(ctx context.Context) ([]githubRelease, error) {
	var list []githubRelease
	for page := 1; page <= StableMaxNotes/100; page++ {
		var batch []githubRelease
		if err := githubGet(ctx, releaseAPI+"?per_page=100&page="+strconv.Itoa(page), &batch); err != nil {
			return nil, err
		}
		for _, r := range batch {
			if r.usable() {
				list = append(list, r)
			}
		}
		if len(batch) < 100 {
			break
		}
	}
	return list, nil
}

func githubLatest(ctx context.Context, lang string) (*Release, error) {
	var chosen githubRelease
	if !Stable() {
		if err := githubGet(ctx, releaseAPI+"/latest", &chosen); err != nil {
			return nil, err
		}
	} else {
		now := time.Now().UTC()
		week := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		week = week.AddDate(0, 0, -(int(week.Weekday())+6)%7)
		cut := week.AddDate(0, 0, -3)
		list, err := githubList(ctx)
		if err != nil {
			return nil, err
		}
		for _, r := range list {
			urgent := urgentNotes.MatchString(r.Body)
			if r.Published.IsZero() || r.Published.After(now) || (r.Published.After(cut) && !urgent) {
				continue
			}
			if chosen.Tag == "" || Newer(r.version(), chosen.version()) {
				chosen = r
			}
		}
	}
	if !chosen.usable() {
		return nil, fmt.Errorf("fork releases: no release available for this channel")
	}
	return githubManifest(ctx, chosen, lang)
}

func githubManifest(ctx context.Context, r githubRelease, lang string) (*Release, error) {
	var sumsURL string
	for _, a := range r.Assets {
		if a.Name == "SHA256SUMS" {
			sumsURL = a.URL
		}
	}
	if sumsURL == "" {
		return nil, fmt.Errorf("fork release %s: missing SHA256SUMS", r.Tag)
	}
	req, err := http.NewRequestWithContext(ctx, "GET", sumsURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := source.DoOfficial(client, req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fork checksums: %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	sums := map[string]string{}
	for line := range strings.SplitSeq(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		h, err := hex.DecodeString(fields[0])
		if err == nil && len(h) == 32 {
			sums[strings.TrimPrefix(fields[1], "*")] = fields[0]
		}
	}
	out := &Release{Version: r.version(), Notes: InLang(r.Body, lang), URL: r.URL, Assets: map[string]Asset{}}
	for _, a := range r.Assets {
		if sum := sums[a.Name]; sum != "" {
			out.Assets[a.Name] = Asset{URL: a.URL, Size: a.Size, SHA256: sum}
		}
	}
	if len(out.Assets) == 0 {
		return nil, fmt.Errorf("fork release %s: no checksummed assets", r.Tag)
	}
	return out, nil
}

func githubNotes(ctx context.Context, q url.Values, lang string) ([]Note, error) {
	upto, after := q.Get("upto"), q.Get("after")
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = MostNotes()
	}
	limit = min(limit, StableMaxNotes)
	list, err := githubList(ctx)
	if err != nil {
		return nil, err
	}
	var notes []Note
	for _, r := range list {
		v := r.version()
		if Newer(v, upto) || (after != "" && !Newer(v, after)) {
			continue
		}
		notes = append(notes, Note{Version: v, Notes: InLang(r.Body, lang), URL: r.URL})
	}
	slices.SortFunc(notes, func(a, b Note) int {
		if Newer(a.Version, b.Version) {
			return -1
		}
		if Newer(b.Version, a.Version) {
			return 1
		}
		return 0
	})
	return notes[:min(len(notes), limit)], nil
}
