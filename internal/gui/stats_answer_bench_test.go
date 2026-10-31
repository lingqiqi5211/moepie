package gui

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"io"
	"testing"

	"github.com/yetone/magpie/internal/sessions"
)

// Compare the previous whole-answer encoding with the two passes used for
// a changed response. Both include hashing and writing, but exclude the
// transport's retained copy. A small and a large history expose the CPU tradeoff.
func BenchmarkStatsAnswer(b *testing.B) {
	for _, days := range []int{7, 365} {
		st := sessions.Stats{From: "2025-01-01", To: "2026-01-01"}
		for i := 0; i < days; i++ {
			d := sessions.Day{Date: "2025-01-01"}
			for j := 0; j < 80; j++ {
				d.Usage = append(d.Usage, sessions.Usage{Agent: "codex", Cwd: "/fixture/project", Model: "gpt", Tokens: sessions.Tokens{Input: 1234}, Cost: 0.02, Priced: true})
			}
			st.Days = append(st.Days, d)
		}
		answer := struct {
			sessions.Stats
			Agents map[string]string `json:"agents"`
		}{st, map[string]string{"codex": "Codex"}}
		b.Run(map[int]string{7: "week", 365: "year"}[days], func(b *testing.B) {
			b.Run("whole", func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					var buf bytes.Buffer
					if err := json.NewEncoder(&buf).Encode(answer); err != nil {
						b.Fatal(err)
					}
					_ = sha256.Sum256(buf.Bytes())
					_, _ = io.Copy(io.Discard, &buf)
				}
			})
			b.Run("days-two-passes", func(b *testing.B) {
				b.ReportAllocs()
				for b.Loop() {
					for _, out := range []io.Writer{sha256.New(), io.Discard} {
						if err := statsAnswer(out, st, answer.Agents); err != nil {
							b.Fatal(err)
						}
					}
				}
			})
		})
	}
}
