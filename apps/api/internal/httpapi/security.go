package httpapi

import (
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/weidoc/weidoc/apps/api/internal/config"
)

func Protect(cfg config.Config, next http.Handler) http.Handler {
	return securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !cfg.IPAllowed(ip) {
			log.Printf("blocked ip=%s method=%s path=%s", ip, r.Method, r.URL.Path)
			writeErr(w, http.StatusForbidden, "forbidden", "来源地址不被允许")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-XSS-Protection", "0")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) allowClient(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.cfg.IPAllowed(clientIP(r)) {
			writeErr(w, http.StatusForbidden, "forbidden", "来源地址不被允许")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) corsOptions() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && s.originAllowed(origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, If-Match, X-Requested-With")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Max-Age", "300")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) originAllowed(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return false
	}
	host := u.Hostname()
	for _, allowed := range s.cfg.AllowedOrigins {
		if allowed == "*" {
			return true
		}
		if strings.EqualFold(strings.TrimRight(allowed, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
		au, err := url.Parse(allowed)
		if err == nil && strings.EqualFold(au.Hostname(), host) && strings.EqualFold(au.Port(), u.Port()) {
			return true
		}
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func clientIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		if x := firstIP(r.Header.Get("X-Real-IP")); x != nil {
			return x
		}
		if x := firstIP(r.Header.Get("X-Forwarded-For")); x != nil {
			return x
		}
	}
	if ip != nil {
		if v4 := ip.To4(); v4 != nil {
			return v4
		}
		return ip
	}
	return net.IPv4(0, 0, 0, 0)
}

func firstIP(v string) net.IP {
	if v == "" {
		return nil
	}
	part := strings.TrimSpace(strings.Split(v, ",")[0])
	host := part
	if h, _, err := net.SplitHostPort(part); err == nil {
		host = h
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	if v4 := ip.To4(); v4 != nil {
		return v4
	}
	return ip
}

type limiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	window time.Duration
	max    int
}

func newLimiter(window time.Duration, max int) *limiter {
	if window <= 0 {
		window = 10 * time.Second
	}
	if max <= 0 {
		max = 80
	}
	return &limiter{hits: map[string][]time.Time{}, window: window, max: max}
}

func (l *limiter) allow(key string) bool {
	now := time.Now()
	cut := now.Add(-l.window)
	l.mu.Lock()
	defer l.mu.Unlock()
	arr := l.hits[key]
	n := 0
	for _, t := range arr {
		if t.After(cut) {
			arr[n] = t
			n++
		}
	}
	arr = arr[:n]
	if len(arr) >= l.max {
		l.hits[key] = arr
		return false
	}
	l.hits[key] = append(arr, now)
	if len(l.hits) > 4096 {
		for k, v := range l.hits {
			keep := v[:0]
			for _, t := range v {
				if t.After(cut) {
					keep = append(keep, t)
				}
			}
			if len(keep) == 0 {
				delete(l.hits, k)
			} else {
				l.hits[k] = keep
			}
		}
	}
	return true
}

type inflight struct {
	mu  sync.Mutex
	n   map[string]int
	max int
}

func newInflight(max int) *inflight {
	if max <= 0 {
		max = 20
	}
	return &inflight{n: map[string]int{}, max: max}
}

func (f *inflight) acquire(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n[key] >= f.max {
		return false
	}
	f.n[key]++
	return true
}

func (f *inflight) release(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.n[key] <= 1 {
		delete(f.n, key)
		return
	}
	f.n[key]--
}

func probePath(p string) bool {
	return p == "/healthz" || p == "/readyz" || strings.HasSuffix(p, "/healthz") || strings.HasSuffix(p, "/readyz")
}

func authPath(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	p := r.URL.Path
	return strings.HasSuffix(p, "/auth/login") || strings.HasSuffix(p, "/auth/setup") || strings.HasSuffix(p, "/auth/refresh")
}

func (s *Server) limitTraffic(next http.Handler) http.Handler {
	general := newLimiter(s.cfg.RateLimitWindow, s.cfg.RateLimitMax)
	auth := newLimiter(s.cfg.RateLimitAuthWindow, s.cfg.RateLimitAuthMax)
	busy := newInflight(s.cfg.RateLimitConcurrent)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if probePath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		key := clientIP(r).String()
		if authPath(r) {
			if !auth.allow(key) {
				w.Header().Set("Retry-After", "60")
				writeErr(w, http.StatusTooManyRequests, "rate_limited", "登录尝试过于频繁，请稍后再试")
				return
			}
		} else if !general.allow(key) {
			w.Header().Set("Retry-After", "10")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "请求过于频繁，请稍后再试")
			return
		}
		if !busy.acquire(key) {
			w.Header().Set("Retry-After", "5")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "并发请求过多，请稍后再试")
			return
		}
		defer busy.release(key)
		next.ServeHTTP(w, r)
	})
}
