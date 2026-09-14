package office

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type Service struct {
	PublicURL   string
	DocsURL     string
	JWTSecret   string
	ContentSign []byte
}

type EditorConfig struct {
	DocumentType string         `json:"documentType"`
	Document     map[string]any `json:"document"`
	EditorConfig map[string]any `json:"editorConfig"`
	Token        string         `json:"token"`
	DocsAPIScript string        `json:"docs_api_script"`
}

type ContentClaims struct {
	NodeID      string `json:"nid"`
	WorkspaceID string `json:"wid"`
	UserID      string `json:"uid"`
	Mode        string `json:"mode"`
	jwt.RegisteredClaims
}

func New(publicURL, docsURL, jwtSecret string) *Service {
	return &Service{
		PublicURL:   strings.TrimRight(publicURL, "/"),
		DocsURL:     strings.TrimRight(docsURL, "/"),
		JWTSecret:   jwtSecret,
		ContentSign: []byte(jwtSecret),
	}
}

func (s *Service) Enabled() bool {
	return s.DocsURL != ""
}

func (s *Service) BuildConfig(nodeID, workspaceID, userID, username, filename, ext, editorKey, mode string) (*EditorConfig, error) {
	if !s.Enabled() {
		return nil, errors.New("onlyoffice not configured")
	}
	docType := documentType(ext)
	if docType == "" {
		return nil, fmt.Errorf("unsupported office type: %s", ext)
	}
	if mode != "view" && mode != "edit" {
		mode = "edit"
	}
	edit := mode == "edit"

	contentToken, err := s.signContentToken(nodeID, workspaceID, userID, mode, 2*time.Hour)
	if err != nil {
		return nil, err
	}
	fileURL := fmt.Sprintf("%s/api/v1/office/content/%s", s.PublicURL, contentToken)
	callbackURL := fmt.Sprintf("%s/api/v1/office/callback?wid=%s&nid=%s&uid=%s", s.PublicURL, workspaceID, nodeID, userID)

	doc := map[string]any{
		"fileType": ext,
		"key":      editorKey,
		"title":    filename,
		"url":      fileURL,
		"permissions": map[string]any{
			"edit":     edit,
			"download": true,
			"print":    true,
			"review":   false,
			"comment":  false,
			"chat":     false,
		},
	}
	ed := map[string]any{
		"mode":        mode,
		"lang":        "zh-CN",
		"callbackUrl": callbackURL,
		"user": map[string]any{
			"id":   userID,
			"name": username,
		},
		"customization": map[string]any{
			"forcesave": true,
			"autosave":  true,
		},
	}
	payload := map[string]any{
		"documentType": docType,
		"document":     doc,
		"editorConfig": ed,
	}
	token, err := signMap(s.JWTSecret, payload)
	if err != nil {
		return nil, err
	}
	return &EditorConfig{
		DocumentType:  docType,
		Document:      doc,
		EditorConfig:  ed,
		Token:         token,
		DocsAPIScript: s.DocsURL + "/web-apps/apps/api/documents/api.js",
	}, nil
}

type CallbackPayload struct {
	Key    string `json:"key"`
	Status int    `json:"status"`
	URL    string `json:"url"`
	Users  []string `json:"users"`
}

func (s *Service) DownloadSaved(rawURL string) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("invalid download url")
	}
	allowed, err := url.Parse(s.DocsURL)
	if err != nil || allowed.Hostname() == "" || !strings.EqualFold(u.Hostname(), allowed.Hostname()) {
		return nil, errors.New("unexpected download host")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download saved file: status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 200*1024*1024))
}

func (s *Service) signContentToken(nodeID, workspaceID, userID, mode string, ttl time.Duration) (string, error) {
	claims := ContentClaims{
		NodeID:      nodeID,
		WorkspaceID: workspaceID,
		UserID:      userID,
		Mode:        mode,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(s.ContentSign)
}

func (s *Service) ParseContentToken(token string) (*ContentClaims, error) {
	parsed, err := jwt.ParseWithClaims(token, &ContentClaims{}, func(t *jwt.Token) (interface{}, error) {
		return s.ContentSign, nil
	})
	if err != nil {
		return nil, err
	}
	c, ok := parsed.Claims.(*ContentClaims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

func documentType(ext string) string {
	switch strings.ToLower(ext) {
	case "doc", "docx", "odt", "rtf", "txt":
		return "word"
	case "xls", "xlsx", "ods":
		return "cell"
	case "ppt", "pptx", "odp":
		return "slide"
	case "pdf":
		return "pdf"
	default:
		return ""
	}
}

func IsOfficeExt(ext string) bool {
	return documentType(ext) != "" && ext != "txt"
}

func signMap(secret string, payload map[string]any) (string, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	var claims jwt.MapClaims
	if err := json.Unmarshal(b, &claims); err != nil {
		return "", err
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(secret))
}

func (s *Service) VerifyCallbackJWT(authHeader string, body []byte) error {
	if s.JWTSecret == "" {
		return errors.New("jwt required")
	}
	var raw map[string]any
	_ = json.Unmarshal(body, &raw)
	tok := ""
	if v, ok := raw["token"].(string); ok {
		tok = v
	}
	if tok == "" && strings.HasPrefix(authHeader, "Bearer ") {
		tok = strings.TrimPrefix(authHeader, "Bearer ")
	}
	if tok == "" {
		return errors.New("missing jwt")
	}
	_, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(s.JWTSecret), nil
	})
	return err
}

func ExtFromFilename(name string) string {
	return strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
}

func MustUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}

func HMACHex(secret, msg string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(msg))
	return hex.EncodeToString(m.Sum(nil))
}

func B64(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}
