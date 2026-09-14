package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/weidoc/weidoc/apps/api/internal/auth"
	"github.com/weidoc/weidoc/apps/api/internal/config"
	"github.com/weidoc/weidoc/apps/api/internal/node"
	"github.com/weidoc/weidoc/apps/api/internal/office"
	"github.com/weidoc/weidoc/apps/api/internal/templates"
)

type Server struct {
	cfg    config.Config
	auth   *auth.Service
	nodes  *node.Service
	office *office.Service
	pool   *pgxpool.Pool
}

func New(cfg config.Config, authSvc *auth.Service, nodes *node.Service, officeSvc *office.Service, pool *pgxpool.Pool) http.Handler {
	s := &Server{cfg: cfg, auth: authSvc, nodes: nodes, office: officeSvc, pool: pool}
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.Recoverer)
	r.Use(s.allowClient)
	r.Use(securityHeaders)
	r.Use(s.limitTraffic)
	r.Use(s.corsOptions())
	r.Use(middleware.Logger)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", s.readyz)

	r.Route("/api/v1", func(api chi.Router) {
		api.Get("/auth/setup/status", s.setupStatus)
		api.Post("/auth/setup", s.setup)
		api.Post("/auth/login", s.login)
		api.Post("/auth/refresh", s.refresh)
		api.Post("/auth/logout", s.logout)

		api.Get("/office/content/{token}", s.officeContent)
		api.Post("/office/callback", s.officeCallback)

		api.Group(func(priv chi.Router) {
			priv.Use(s.authMiddleware)
			priv.Get("/auth/me", s.me)
			priv.Put("/auth/password", s.changePassword)

			priv.Get("/workspaces", s.listWorkspaces)
			priv.Route("/workspaces/{wid}", func(ws chi.Router) {
				ws.Get("/tree", s.listTree)
				ws.Get("/nodes/{id}", s.getNode)
				ws.Get("/nodes/{id}/breadcrumb", s.breadcrumb)
				ws.Post("/folders", s.createFolder)
				ws.Post("/files", s.createFile)
				ws.Post("/upload", s.upload)
				ws.Post("/files/{id}/import", s.importIntoFile)
				ws.Patch("/nodes/{id}", s.patchNode)
				ws.Post("/nodes/move", s.moveNodes)
				ws.Post("/nodes/{id}/copy", s.copyNode)
				ws.Delete("/nodes/{id}", s.deleteNode)
				ws.Get("/trash", s.listTrash)
				ws.Post("/trash/{id}/restore", s.restore)
				ws.Delete("/trash/{id}", s.hardDelete)
				ws.Get("/files/{id}/content", s.getContent)
				ws.Put("/files/{id}/content", s.putContent)
				ws.Get("/files/{id}/download", s.download)
				ws.Post("/files/{id}/office/session", s.officeSession)
				ws.Post("/files/{id}/lock/renew", s.renewLock)
				ws.Delete("/files/{id}/lock", s.releaseLock)
				ws.Get("/search", s.search)
			})
			priv.Get("/recents", s.recents)

			priv.Group(func(adm chi.Router) {
				adm.Use(s.adminOnly)
				adm.Get("/admin/users", s.adminListUsers)
				adm.Post("/admin/users", s.adminCreateUser)
				adm.Patch("/admin/users/{id}/status", s.adminSetStatus)
				adm.Get("/admin/settings", s.getSettings)
				adm.Put("/admin/settings", s.putSettings)
			})
		})
	})

	return r
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	if err := s.pool.Ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "onlyoffice": s.office.Enabled()})
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	ok, err := s.auth.IsSetup(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"setup": ok})
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	res, err := s.auth.Setup(r.Context(), req.Username, req.Password)
	if errors.Is(err, auth.ErrAlreadySetup) {
		writeErr(w, http.StatusConflict, "already_setup", "system already initialized")
		return
	}
	if errors.Is(err, auth.ErrWeakPassword) {
		writeErr(w, http.StatusBadRequest, "weak_password", "password must be at least 8 characters")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.setRefreshCookie(w, res.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": res.AccessToken,
		"expires_at":   res.ExpiresAt,
		"user":         res.User,
	})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	res, err := s.auth.Login(r.Context(), req.Username, req.Password, r.UserAgent(), r.RemoteAddr)
	if errors.Is(err, auth.ErrLocked) {
		writeErr(w, http.StatusLocked, "locked", "账号已临时锁定，请稍后再试")
		return
	}
	if errors.Is(err, auth.ErrDisabled) {
		writeErr(w, http.StatusForbidden, "disabled", "账号已停用，请联系管理员启用")
		return
	}
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "用户名或密码不正确")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	s.setRefreshCookie(w, res.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": res.AccessToken,
		"expires_at":   res.ExpiresAt,
		"user":         res.User,
	})
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	rt, _ := r.Cookie("refresh_token")
	token := ""
	if rt != nil {
		token = rt.Value
	}
	var body struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = readJSON(r, &body)
	if body.RefreshToken != "" {
		token = body.RefreshToken
	}
	res, err := s.auth.Refresh(r.Context(), token, r.UserAgent(), r.RemoteAddr)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid refresh token")
		return
	}
	s.setRefreshCookie(w, res.RefreshToken)
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": res.AccessToken,
		"expires_at":   res.ExpiresAt,
		"user":         res.User,
	})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	rt, _ := r.Cookie("refresh_token")
	if rt != nil {
		_ = s.auth.Logout(r.Context(), rt.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: "refresh_token", Value: "", Path: "/api/v1/auth", MaxAge: -1, HttpOnly: true})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r)
	writeJSON(w, http.StatusOK, u)
}

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	claims := claimsFrom(r)
	uid, _ := uuid.Parse(claims.UserID)
	err := s.auth.ChangePassword(r.Context(), uid, req.OldPassword, req.NewPassword)
	if errors.Is(err, auth.ErrInvalidCredentials) {
		writeErr(w, http.StatusUnauthorized, "invalid_credentials", "old password incorrect")
		return
	}
	if errors.Is(err, auth.ErrWeakPassword) {
		writeErr(w, http.StatusBadRequest, "weak_password", "password too weak")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	list, err := s.nodes.ListWorkspaces(r.Context(), uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) withWorkspace(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	wid, err := uuid.Parse(chi.URLParam(r, "wid"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid workspace id")
		return uuid.Nil, false
	}
	if err := s.nodes.EnsureOwner(r.Context(), wid, userID(r)); err != nil {
		mapNodeErr(w, err)
		return uuid.Nil, false
	}
	return wid, true
}

func (s *Server) listTree(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	var parent *uuid.UUID
	if p := r.URL.Query().Get("parent_id"); p != "" {
		id, err := uuid.Parse(p)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid parent_id")
			return
		}
		parent = &id
	}
	list, err := s.nodes.ListChildren(r.Context(), wid, parent)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) getNode(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	n, err := s.nodes.Get(r.Context(), wid, id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) breadcrumb(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	list, err := s.nodes.Breadcrumb(r.Context(), wid, id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	var req struct {
		ParentID *uuid.UUID `json:"parent_id"`
		Name     string     `json:"name"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	n, err := s.nodes.CreateFolder(r.Context(), wid, userID(r), req.ParentID, req.Name)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) createFile(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	var req struct {
		ParentID *uuid.UUID `json:"parent_id"`
		Name     string     `json:"name"`
		Kind     string     `json:"kind"` // md|docx|xlsx|pptx|pdf|txt
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	kind := req.Kind
	if kind == "" {
		kind = "md"
	}
	name := req.Name
	if name == "" {
		switch kind {
		case "docx":
			name = "未命名文档.docx"
		case "xlsx":
			name = "未命名表格.xlsx"
		case "pptx":
			name = "未命名演示.pptx"
		case "pdf":
			name = "未命名文档.pdf"
		case "txt":
			name = "未命名文本.txt"
		case "md", "markdown":
			name = "未命名笔记.md"
			kind = "md"
		default:
			name = "未命名笔记.md"
			kind = "md"
		}
	}
	content, err := templates.ByExt(kind)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	n, err := s.nodes.CreateFile(r.Context(), wid, userID(r), req.ParentID, name, content)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+1024*1024)
	if err := r.ParseMultipartForm(s.cfg.MaxUploadBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid multipart")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "file required")
		return
	}
	defer file.Close()
	var parent *uuid.UUID
	if p := r.FormValue("parent_id"); p != "" {
		id, err := uuid.Parse(p)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid parent_id")
			return
		}
		parent = &id
	}
	n, err := s.nodes.Upload(r.Context(), wid, userID(r), parent, hdr.Filename, file, hdr.Size)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) importIntoFile(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+1024*1024)
	if err := r.ParseMultipartForm(s.cfg.MaxUploadBytes); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid multipart")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "file required")
		return
	}
	defer file.Close()
	n, err := s.nodes.ImportInto(r.Context(), wid, userID(r), id, hdr.Filename, file, hdr.Size)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) patchNode(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var req struct {
		Name *string `json:"name"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if req.Name == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "name required")
		return
	}
	n, err := s.nodes.Rename(r.Context(), wid, userID(r), id, *req.Name)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) moveNodes(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	var req struct {
		IDs            []uuid.UUID `json:"ids"`
		TargetParentID *uuid.UUID  `json:"target_parent_id"`
		BeforeID       *uuid.UUID  `json:"before_id"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if err := s.nodes.Move(r.Context(), wid, userID(r), req.IDs, req.TargetParentID, req.BeforeID); err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) copyNode(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	n, err := s.nodes.Copy(r.Context(), wid, userID(r), id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) deleteNode(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	if err := s.nodes.SoftDelete(r.Context(), wid, userID(r), id); err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) listTrash(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	list, err := s.nodes.ListTrash(r.Context(), wid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	n, err := s.nodes.Restore(r.Context(), wid, userID(r), id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) hardDelete(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	if err := s.nodes.HardDelete(r.Context(), wid, id); err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) getContent(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	data, n, err := s.nodes.ReadContent(r.Context(), wid, id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	s.nodes.TouchRecent(r.Context(), userID(r), id)
	writeJSON(w, http.StatusOK, map[string]any{
		"node":    n,
		"content": string(data),
		"version": n.Version,
	})
}

func (s *Server) putContent(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var req struct {
		Content string `json:"content"`
		Version int    `json:"version"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	ifMatch := r.Header.Get("If-Match")
	if ifMatch != "" {
		if v, err := strconv.Atoi(ifMatch); err == nil {
			req.Version = v
		}
	}
	n, err := s.nodes.SaveContent(r.Context(), wid, userID(r), id, []byte(req.Content), req.Version)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	data, n, err := s.nodes.ReadContent(r.Context(), wid, id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	ct := "application/octet-stream"
	if n.Mime != nil && *n.Mime != "" {
		ct = *n.Mime
	} else if n.Ext != "" {
		if t := mime.TypeByExtension("." + n.Ext); t != "" {
			ct = t
		}
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "attachment; filename=\""+n.Name+"\"")
	_, _ = w.Write(data)
}

func (s *Server) officeSession(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var req struct {
		Mode string `json:"mode"`
	}
	_ = readJSON(r, &req)
	if req.Mode == "" {
		req.Mode = "edit"
	}
	n, err := s.nodes.Get(r.Context(), wid, id)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	if !office.IsOfficeExt(n.Ext) && n.Ext != "pdf" {
		writeErr(w, http.StatusBadRequest, "unsupported", "not an office document")
		return
	}
	if data, _, err := s.nodes.ReadContent(r.Context(), wid, id); err != nil {
		mapNodeErr(w, err)
		return
	} else if err := node.ValidateFileContent(n.Ext, data); err != nil {
		mapNodeErr(w, err)
		return
	}
	claims := claimsFrom(r)
	if req.Mode == "edit" {
		if err := s.nodes.AcquireLock(r.Context(), id, userID(r), claims.UserID, 30*time.Minute); err != nil {
			mapNodeErr(w, err)
			return
		}
	}
	key := ""
	if n.EditorKey != nil {
		key = *n.EditorKey
	}
	if key == "" {
		key = n.ID.String() + "_" + strconv.Itoa(n.Version)
		_ = s.nodes.SetEditorKey(r.Context(), id, key)
	}
	cfg, err := s.office.BuildConfig(id.String(), wid.String(), claims.UserID, claims.Username, n.Name, n.Ext, key, req.Mode)
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "onlyoffice_unavailable", err.Error())
		return
	}
	// 浏览器用局域网 IP 打开时，把 localhost 的 Docs 地址改写成同一主机 IP
	cfg.DocsAPIScript = rewriteLocalhostURL(cfg.DocsAPIScript, browserHostname(r))
	s.nodes.TouchRecent(r.Context(), userID(r), id)
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) renewLock(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	if err := s.nodes.RenewLock(r.Context(), id, userID(r), 30*time.Minute); err != nil {
		mapNodeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) releaseLock(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	_ = s.nodes.ReleaseLock(r.Context(), id, userID(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) officeContent(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	claims, err := s.office.ParseContentToken(tok)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid token")
		return
	}
	wid, _ := uuid.Parse(claims.WorkspaceID)
	nid, _ := uuid.Parse(claims.NodeID)
	data, n, err := s.nodes.ReadContent(r.Context(), wid, nid)
	if err != nil {
		mapNodeErr(w, err)
		return
	}
	ct := "application/octet-stream"
	if n.Mime != nil {
		ct = *n.Mime
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write(data)
}

func (s *Server) officeCallback(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]int{"error": 1})
		return
	}
	if err := s.office.VerifyCallbackJWT(r.Header.Get("Authorization"), body); err != nil {
		writeJSON(w, http.StatusOK, map[string]int{"error": 1})
		return
	}

	var payload office.CallbackPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		writeJSON(w, http.StatusOK, map[string]int{"error": 1})
		return
	}
	wid, err1 := uuid.Parse(r.URL.Query().Get("wid"))
	nid, err2 := uuid.Parse(r.URL.Query().Get("nid"))
	uid, err3 := uuid.Parse(r.URL.Query().Get("uid"))
	if err1 != nil || err2 != nil || err3 != nil {
		writeJSON(w, http.StatusOK, map[string]int{"error": 1})
		return
	}

	switch payload.Status {
	case 2, 6:
		if payload.URL == "" {
			writeJSON(w, http.StatusOK, map[string]int{"error": 1})
			return
		}
		data, err := s.office.DownloadSaved(payload.URL)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]int{"error": 1})
			return
		}
		if _, err := s.nodes.UpdateAfterOfficeSave(r.Context(), wid, nid, uid, data); err != nil {
			writeJSON(w, http.StatusOK, map[string]int{"error": 1})
			return
		}
	case 4:
		_ = s.nodes.ReleaseLock(r.Context(), nid, uid)
	}
	writeJSON(w, http.StatusOK, map[string]int{"error": 0})
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	wid, ok := s.withWorkspace(w, r)
	if !ok {
		return
	}
	q := r.URL.Query().Get("q")
	if len(q) > 100 {
		q = q[:100]
	}
	list, err := s.nodes.Search(r.Context(), wid, q)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "search failed")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) recents(w http.ResponseWriter, r *http.Request) {
	list, err := s.nodes.ListRecent(r.Context(), userID(r), 20)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "query failed")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) adminListUsers(w http.ResponseWriter, r *http.Request) {
	list, err := s.auth.ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", "query failed")
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) adminCreateUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	u, err := s.auth.CreateUser(r.Context(), req.Username, req.Password, req.Role, s.cfg.DefaultQuotaBytes)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) adminSetStatus(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid id")
		return
	}
	var req struct {
		Status string `json:"status"`
	}
	if err := readJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid json")
		return
	}
	if err := s.auth.SetUserStatus(r.Context(), userID(r), id, req.Status); err != nil {
		if errors.Is(err, auth.ErrSelfDisable) || errors.Is(err, auth.ErrLastAdmin) {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	host := browserHostname(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"public_base_url":      s.cfg.PublicBaseURL,
		"onlyoffice_url":       rewriteLocalhostURL(s.cfg.OnlyOfficeURL, host),
		"onlyoffice_enabled":   s.office.Enabled(),
		"max_upload_bytes":     s.cfg.MaxUploadBytes,
		"trash_retention_days": s.cfg.TrashRetentionDays,
	})
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"message": "runtime settings via env; persisted settings upcoming"})
}

func (s *Server) setRefreshCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    token,
		Path:     "/api/v1/auth",
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.cfg.RefreshTokenTTL.Seconds()),
	})
}

// browserHostname 从 Origin / Referer / Host 推断浏览器实际访问的主机名（支持局域网 IP）。
func browserHostname(r *http.Request) string {
	for _, raw := range []string{r.Header.Get("Origin"), r.Header.Get("Referer")} {
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || u.Hostname() == "" {
			continue
		}
		return u.Hostname()
	}
	if xf := r.Header.Get("X-Forwarded-Host"); xf != "" {
		host := strings.TrimSpace(strings.Split(xf, ",")[0])
		if h, _, err := net.SplitHostPort(host); err == nil {
			return h
		}
		return host
	}
	host := r.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

// rewriteLocalhostURL 把 URL 里的 localhost/127.0.0.1 换成浏览器主机，便于局域网访问。
func rewriteLocalhostURL(raw, browserHost string) string {
	if raw == "" || browserHost == "" {
		return raw
	}
	if browserHost == "localhost" || browserHost == "127.0.0.1" || browserHost == "::1" {
		return raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	h := u.Hostname()
	if h != "localhost" && h != "127.0.0.1" && h != "::1" {
		return raw
	}
	if p := u.Port(); p != "" {
		u.Host = net.JoinHostPort(browserHost, p)
	} else {
		u.Host = browserHost
	}
	return u.String()
}
