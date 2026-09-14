package config

import (
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppEnv              string
	HTTPAddr            string
	PublicBaseURL       string
	DatabaseURL         string
	DataDir             string
	JWTAccessSecret     string
	JWTRefreshSecret    string
	AccessTokenTTL      time.Duration
	RefreshTokenTTL     time.Duration
	OnlyOfficeURL       string
	OnlyOfficeInternal  string
	OnlyOfficeJWTSecret string
	MaxUploadBytes      int64
	DefaultQuotaBytes   int64
	TrashRetentionDays  int
	AllowedExtensions   map[string]struct{}
	CookieSecure        bool
	AllowedOrigins      []string
	AllowedCIDRs        []*net.IPNet
	DeniedCIDRs         []*net.IPNet
	RateLimitWindow     time.Duration
	RateLimitMax        int
	RateLimitAuthWindow time.Duration
	RateLimitAuthMax    int
	RateLimitConcurrent int
	DBMaxConns          int32
}

func Load() Config {
	exts := strings.Split(getenv("ALLOWED_EXTENSIONS", "md,markdown,txt,json,yaml,yml,docx,doc,xlsx,xls,csv,pptx,ppt,pdf,png,jpg,jpeg,gif,webp,svg"), ",")
	allowed := make(map[string]struct{}, len(exts))
	for _, e := range exts {
		e = strings.ToLower(strings.TrimSpace(e))
		if e != "" {
			allowed[e] = struct{}{}
		}
	}

	return Config{
		AppEnv:              getenv("APP_ENV", "development"),
		HTTPAddr:            getenv("HTTP_ADDR", ":8080"),
		PublicBaseURL:       strings.TrimRight(getenv("PUBLIC_BASE_URL", "http://localhost:8080"), "/"),
		DatabaseURL:         resolveDatabaseURL(),
		DataDir:             getenv("DATA_DIR", "./data"),
		JWTAccessSecret:     getenv("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
		JWTRefreshSecret:    getenv("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
		AccessTokenTTL:      durationEnv("ACCESS_TOKEN_TTL", 30*time.Minute),
		RefreshTokenTTL:     durationEnv("REFRESH_TOKEN_TTL", 14*24*time.Hour),
		OnlyOfficeURL:       strings.TrimRight(getenv("ONLYOFFICE_URL", ""), "/"),
		OnlyOfficeInternal:  strings.TrimRight(getenv("ONLYOFFICE_INTERNAL_URL", ""), "/"),
		OnlyOfficeJWTSecret: getenv("ONLYOFFICE_JWT_SECRET", "onlyoffice-jwt-secret-change-me"),
		MaxUploadBytes:      int64Env("MAX_UPLOAD_BYTES", 200*1024*1024),
		DefaultQuotaBytes:   int64Env("DEFAULT_QUOTA_BYTES", 10*1024*1024*1024),
		TrashRetentionDays:  intEnv("TRASH_RETENTION_DAYS", 30),
		AllowedExtensions:   allowed,
		CookieSecure:        getenv("COOKIE_SECURE", "false") == "true",
		AllowedOrigins:      splitCSV(getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173")),
		AllowedCIDRs:        parseCIDRs(getenv("ALLOWED_CIDRS", "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16")),
		DeniedCIDRs:         parseCIDRs(getenv("DENIED_CIDRS", "")),
		RateLimitWindow:     durationEnv("RATE_LIMIT_WINDOW", 10*time.Second),
		RateLimitMax:        intEnv("RATE_LIMIT_MAX", 80),
		RateLimitAuthWindow: durationEnv("RATE_LIMIT_AUTH_WINDOW", 10*time.Minute),
		RateLimitAuthMax:    intEnv("RATE_LIMIT_AUTH_MAX", 10),
		RateLimitConcurrent: intEnv("RATE_LIMIT_CONCURRENT", 20),
		DBMaxConns:          int32(intEnv("DB_MAX_CONNS", 20)),
	}
}

func (c Config) IPAllowed(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range c.DeniedCIDRs {
		if n.Contains(ip) {
			return false
		}
	}
	if ip.IsLoopback() {
		return true
	}
	if len(c.AllowedCIDRs) == 0 {
		return false
	}
	for _, n := range c.AllowedCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func splitCSV(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseCIDRs(v string) []*net.IPNet {
	var out []*net.IPNet
	for _, p := range splitCSV(v) {
		if !strings.Contains(p, "/") {
			if ip := net.ParseIP(p); ip != nil {
				if ip.To4() != nil {
					p += "/32"
				} else {
					p += "/128"
				}
			}
		}
		_, n, err := net.ParseCIDR(p)
		if err == nil {
			out = append(out, n)
		}
	}
	return out
}

// resolveDatabaseURL prefers DATABASE_URL; otherwise builds from DB_* pieces.
func resolveDatabaseURL() string {
	if v := os.Getenv("DATABASE_URL"); v != "" {
		return v
	}
	host := getenv("DB_HOST", "127.0.0.1")
	port := getenv("DB_PORT", "5432")
	user := getenv("DB_USER", "postgres")
	pass := getenv("DB_PASSWORD", "postgres")
	name := getenv("DB_NAME", "weidoc")
	ssl := getenv("DB_SSLMODE", "disable")
	return "postgres://" + user + ":" + pass + "@" + host + ":" + port + "/" + name + "?sslmode=" + ssl
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func intEnv(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func int64Env(k string, def int64) int64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

func durationEnv(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
