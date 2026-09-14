package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/weidoc/weidoc/apps/api/internal/auth"
	"github.com/weidoc/weidoc/apps/api/internal/config"
	"github.com/weidoc/weidoc/apps/api/internal/db"
	"github.com/weidoc/weidoc/apps/api/internal/httpapi"
	"github.com/weidoc/weidoc/apps/api/internal/node"
	"github.com/weidoc/weidoc/apps/api/internal/office"
	"github.com/weidoc/weidoc/apps/api/internal/storage"
)

func main() {
	config.LoadDotEnv(".env")
	config.LoadDotEnv("../../.env")
	cfg := config.Load()
	ctx := context.Background()

	pool, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}

	dataDir, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		log.Fatalf("data dir: %v", err)
	}
	store, err := storage.NewLocal(dataDir)
	if err != nil {
		log.Fatalf("storage: %v", err)
	}

	authSvc := auth.NewService(pool, cfg.JWTAccessSecret, cfg.JWTRefreshSecret, cfg.AccessTokenTTL, cfg.RefreshTokenTTL, cfg.DefaultQuotaBytes)
	nodeSvc := node.NewService(pool, store, cfg.AllowedExtensions, cfg.MaxUploadBytes)
	officeSvc := office.New(cfg.PublicBaseURL, cfg.OnlyOfficeURL, cfg.OnlyOfficeJWTSecret)

	handler := httpapi.New(cfg, authSvc, nodeSvc, officeSvc, pool)

	// Serve frontend if dist exists
	webDist := os.Getenv("WEB_DIST")
	if webDist == "" {
		webDist = filepath.Join("..", "web", "dist")
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", handler)
	mux.Handle("/healthz", handler)
	mux.Handle("/readyz", handler)
	if st, err := os.Stat(webDist); err == nil && st.IsDir() {
		fs := http.FileServer(http.Dir(webDist))
		mux.Handle("/", spaHandler(webDist, fs))
		log.Printf("serving frontend from %s", webDist)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("微文档 API 已启动。请构建并配置前端，或开发模式访问 Vite。\n"))
		})
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpapi.Protect(cfg, mux),
		ReadHeaderTimeout: 8 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		log.Printf("微文档 API listening on %s (public=%s onlyoffice=%v)", cfg.HTTPAddr, cfg.PublicBaseURL, officeSvc.Enabled())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func spaHandler(dist string, fileServer http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)
		path := filepath.Join(dist, clean)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			// hashed assets can be cached; HTML must not, or users stick on old UI
			if clean == "/" || clean == "." || clean == string(filepath.Separator) || filepath.Base(path) == "index.html" {
				w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
				w.Header().Set("Pragma", "no-cache")
			} else if filepath.Ext(path) != "" {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
}
