package netproxy

import (
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// How long a loopback proxy's port is taken as listening (portUp) or not
// (portDown) once looked at; a proxy app opened after magpie is taken
// within portDown.
var (
	portUp    = 15 * time.Second
	portDown  = 2 * time.Second
	dialProxy = dialPort
)

// dialPort is whether something takes a connection at addr.
func dialPort(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err == nil {
		c.Close()
	}
	return err == nil
}

var proxyPorts struct {
	sync.Mutex
	seen map[string]proxyPort
}

type proxyPort struct {
	at time.Time
	up bool
}

// listening is whether p's port has a listener, for a loopback p; any
// other is taken as it is, since a proxy that is down can't be told from
// a network that drops a probe. Auto asks it of the system's proxy
// (liveSystem).
func listening(p *url.URL) bool {
	if !loopback(strings.ToLower(p.Hostname())) {
		return true
	}
	port := p.Port()
	if port == "" {
		switch p.Scheme {
		case "https":
			port = "443"
		case "socks5", "socks5h", "socks4", "socks4a", "socks":
			port = "1080"
		default:
			port = "80"
		}
	}
	addr := net.JoinHostPort(p.Hostname(), port)
	proxyPorts.Lock()
	s, ok := proxyPorts.seen[addr]
	proxyPorts.Unlock()
	keep := portDown
	if s.up {
		keep = portUp
	}
	if ok && time.Since(s.at) < keep {
		return s.up
	}
	up := dialProxy(addr)
	proxyPorts.Lock()
	if proxyPorts.seen == nil {
		proxyPorts.seen = map[string]proxyPort{}
	}
	proxyPorts.seen[addr] = proxyPort{time.Now(), up}
	proxyPorts.Unlock()
	return up
}
