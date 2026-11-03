// Package gateway is the Gateway page: the gateway's state, its keys, how
// to connect a client and the models it serves. The
// gateway itself is core and serves agents with the page off; while a
// gateway key is there, the page that lists and changes them stays on.
//
// It is the first part of the window a plugin draws itself (P1 of
// docs/subsystems/plugin-runtime.md): its scripts register the page with
// the window's kernel.
package gateway

import (
	"github.com/yetone/magpie/internal/access"
	"github.com/yetone/magpie/internal/pluginrt"
)

func init() {
	pluginrt.Register(pluginrt.Manifest{
		ID: "gateway", API: "^1", Requires: []string{"window", "gateway"}, Essential: true,
		Name: "Gateway page", Sub: "The gateway's state, keys and settings, how to connect a client and its models",
		Group: pluginrt.GroupPages, Order: 4, Where: []string{"Models › Gateway"},
		One: "1 gateway key", Many: "{n} gateway keys",
		InUse: func() (int, error) {
			keys, err := access.List()
			return len(keys), err
		},
		Parts:  []pluginrt.Part{{Slot: "nav.page", Key: "gateway"}},
		Client: []string{"keys.js", "client.js"},
	})
}
