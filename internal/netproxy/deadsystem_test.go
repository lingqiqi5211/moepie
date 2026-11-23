package netproxy

import (
	"net"
	"net/url"
	"strings"
	"testing"

	"github.com/yetone/magpie/internal/settings"
)

// freePort is a loopback port nothing listens on, as a closed proxy app's.
func freePort(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close() // a freed port may be handed to anything next: the test stubs the dial
	return addr
}

func proxyFor(t *testing.T, raw string) string {
	t.Helper()
	u, _ := url.Parse(raw)
	p, err := For(u)
	if err != nil {
		t.Fatalf("For(%s): %v", raw, err)
	}
	if p == nil {
		return ""
	}
	return p.String()
}

func envVal(env []string, k string) string {
	for _, e := range env {
		if kk, v, ok := strings.Cut(e, "="); ok && kk == k {
			return v
		}
	}
	return ""
}

// downPort stubs the listening check: addr is down until the returned up
// is called; every other port is up. The cache of looks is cleared each
// way, so a test sees the move at once.
func downPort(t *testing.T, addr string) (up func()) {
	t.Helper()
	isUp := false
	old := dialProxy
	dialProxy = func(a string) bool { return a != addr || isUp }
	forget := func() {
		proxyPorts.Lock()
		proxyPorts.seen = nil
		proxyPorts.Unlock()
	}
	forget()
	t.Cleanup(func() { dialProxy = old; forget() })
	return func() { isUp = true; forget() }
}

// @bitssly on X (Windows, proxy Auto): a VPN app turned off left Internet
// Options' proxy at its loopback port, and every request failed with 502
// "proxy not reachable", a restart of magpie too, until Off. A system
// proxy on loopback that nothing listens on is now none: requests, a
// CLI's or a plugin host's env, and the settings page go direct, and
// the page says why. The proxy app coming back is taken again.
func TestDeadLoopbackSystemProxyGoesDirect(t *testing.T) {
	clearProxyEnv(t)
	addr := freePort(t)
	up := downPort(t, addr)
	sysCache.p = Proxy{URL: "http://" + addr, HTTP: "http://" + addr, Bypass: []string{"<local>"}}

	if got := proxyFor(t, "https://api.example/"); got != "" {
		t.Fatalf("a dead system proxy was taken: %q", got)
	}
	if got, from := Describe(); got != "http://"+addr || from != "down" {
		t.Fatalf("Describe = %q (%s), want the dead address (down)", got, from)
	}
	if env := Env([]string{"PATH=/bin"}); envVal(env, "HTTPS_PROXY") != "" {
		t.Fatalf("a CLI was given a dead system proxy: %q", env)
	}

	up()
	if got := proxyFor(t, "https://api.example/"); got != "http://"+addr {
		t.Fatalf("the proxy app came back and wasn't taken: %q", got)
	}
	if got, from := Describe(); from != "system" || got != "http://"+addr {
		t.Fatalf("Describe = %q (%s), want system", got, from)
	}
	if env := Env([]string{"PATH=/bin"}); envVal(env, "HTTPS_PROXY") != "http://"+addr {
		t.Fatalf("a CLI wasn't given the live system proxy: %q", env)
	}
}

// A system proxy elsewhere than loopback is taken as it is: magpie can't
// tell a proxy that is down from a network that drops a probe.
func TestRemoteSystemProxyIsNotProbed(t *testing.T) {
	clearProxyEnv(t)
	old := dialProxy
	dialProxy = func(a string) bool { t.Errorf("probed %s", a); return false }
	t.Cleanup(func() { dialProxy = old })
	sysCache.p = Proxy{URL: "http://10.9.8.7:3128"}
	if got := proxyFor(t, "https://api.example/"); got != "http://10.9.8.7:3128" {
		t.Fatalf("a remote system proxy was dropped: %q", got)
	}
}

// The environment's proxy is set for this process by whoever started it,
// and taken as it is, dead or not.
func TestDeadEnvProxyIsKept(t *testing.T) {
	clearProxyEnv(t)
	dead := freePort(t)
	downPort(t, dead)
	// ALL_PROXY: Go reads HTTPS_PROXY once per process (ProxyFromEnvironment)
	t.Setenv("ALL_PROXY", "http://"+dead)
	if got := proxyFor(t, "https://api.example/"); got != "http://"+dead {
		t.Fatalf("the environment's proxy was gone around: %q", got)
	}
	if env := Env([]string{"HTTPS_PROXY=http://" + dead}); envVal(env, "HTTPS_PROXY") != "http://"+dead {
		t.Fatalf("a CLI's own proxy was taken out: %q", env)
	}
}

// A proxy set in magpie is never gone around, dead or not: requests fail
// through it, so the user sees it, rather than leave from where they said
// not to.
func TestDeadProxySetInMagpieStillFails(t *testing.T) {
	clearProxyEnv(t)
	addr := freePort(t)
	downPort(t, addr)
	if err := settings.Save(settings.Settings{Proxy: "http://" + addr}); err != nil {
		t.Fatal(err)
	}
	if got := proxyFor(t, "https://api.example/"); got != "http://"+addr {
		t.Fatalf("a proxy set in magpie was gone around: %q", got)
	}
	if env := Env([]string{"PATH=/bin"}); envVal(env, "HTTPS_PROXY") != "http://"+addr {
		t.Fatalf("a CLI went around the proxy set in magpie: %q", env)
	}
}
