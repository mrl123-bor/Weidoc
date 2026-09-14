package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/weidoc/weidoc/apps/api/internal/auth"
	"github.com/weidoc/weidoc/apps/api/internal/node"
)

type ctxKey string

const (
	claimsKey ctxKey = "claims"
	userKey   ctxKey = "user"
)

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "missing token")
			return
		}
		token := strings.TrimPrefix(h, "Bearer ")
		claims, err := s.auth.ParseAccessToken(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid token")
			return
		}
		uid, err := uuid.Parse(claims.UserID)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid token")
			return
		}
		u, err := s.auth.GetUser(r.Context(), uid)
		if err != nil || u.Status != "active" {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "user inactive")
			return
		}
		ctx := context.WithValue(r.Context(), claimsKey, claims)
		ctx = context.WithValue(ctx, userKey, u)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) adminOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r)
		if u == nil || u.Role != "admin" || u.Status != "active" {
			writeErr(w, http.StatusForbidden, "forbidden", "admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func claimsFrom(r *http.Request) *auth.Claims {
	v, _ := r.Context().Value(claimsKey).(*auth.Claims)
	return v
}

func userFrom(r *http.Request) *auth.User {
	v, _ := r.Context().Value(userKey).(*auth.User)
	return v
}

func userID(r *http.Request) uuid.UUID {
	u := userFrom(r)
	if u == nil {
		return uuid.Nil
	}
	return u.ID
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"code": code, "message": message})
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func mapNodeErr(w http.ResponseWriter, err error) {
	switch err {
	case node.ErrNotFound:
		writeErr(w, http.StatusNotFound, "not_found", err.Error())
	case node.ErrConflict:
		writeErr(w, http.StatusConflict, "conflict", err.Error())
	case node.ErrInvalidName, node.ErrForbiddenExt, node.ErrInvalidMove, node.ErrTypeMismatch, node.ErrInvalidContent:
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	case node.ErrNotOwner:
		writeErr(w, http.StatusForbidden, "forbidden", err.Error())
	case node.ErrQuotaExceeded:
		writeErr(w, http.StatusInsufficientStorage, "quota_exceeded", err.Error())
	case node.ErrLocked:
		writeErr(w, http.StatusLocked, "locked", err.Error())
	default:
		writeErr(w, http.StatusInternalServerError, "internal", "internal error")
	}
}
