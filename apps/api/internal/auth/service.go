package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrLocked             = errors.New("account locked")
	ErrDisabled           = errors.New("账号已停用")
	ErrAlreadySetup       = errors.New("already setup")
	ErrNotSetup           = errors.New("system not setup")
	ErrWeakPassword       = errors.New("password too weak")
	ErrSelfDisable        = errors.New("不能停用当前登录的账号")
	ErrLastAdmin          = errors.New("不能停用最后一个管理员")
)

type Service struct {
	pool           *pgxpool.Pool
	accessSecret   []byte
	refreshSecret  []byte
	accessTTL      time.Duration
	refreshTTL     time.Duration
	defaultQuota   int64
}

type User struct {
	ID         uuid.UUID `json:"id"`
	Username   string    `json:"username"`
	Email      *string   `json:"email,omitempty"`
	Role       string    `json:"role"`
	Status     string    `json:"status"`
	QuotaBytes int64     `json:"quota_bytes"`
	CreatedAt  time.Time `json:"created_at"`
}

type Claims struct {
	UserID   string `json:"uid"`
	Username string `json:"username"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

type LoginResult struct {
	AccessToken  string    `json:"access_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	User         User      `json:"user"`
	RefreshToken string    `json:"-"`
}

func NewService(pool *pgxpool.Pool, accessSecret, refreshSecret string, accessTTL, refreshTTL time.Duration, defaultQuota int64) *Service {
	return &Service{
		pool:          pool,
		accessSecret:  []byte(accessSecret),
		refreshSecret: []byte(refreshSecret),
		accessTTL:     accessTTL,
		refreshTTL:    refreshTTL,
		defaultQuota:  defaultQuota,
	}
}

func (s *Service) IsSetup(ctx context.Context) (bool, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n > 0, err
}

func (s *Service) Setup(ctx context.Context, username, password string) (*LoginResult, error) {
	ok, err := s.IsSetup(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		return nil, ErrAlreadySetup
	}
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var user User
	err = tx.QueryRow(ctx, `
		INSERT INTO users(username, password_hash, role, quota_bytes)
		VALUES($1,$2,'admin',$3)
		RETURNING id, username, email, role, status, quota_bytes, created_at
	`, strings.TrimSpace(username), string(hash), s.defaultQuota).Scan(
		&user.ID, &user.Username, &user.Email, &user.Role, &user.Status, &user.QuotaBytes, &user.CreatedAt,
	)
	if err != nil {
		return nil, err
	}

	var wsID uuid.UUID
	err = tx.QueryRow(ctx, `
		INSERT INTO workspaces(owner_user_id, name) VALUES($1, '我的文档') RETURNING id
	`, user.ID).Scan(&wsID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.issueTokens(ctx, user, "", "")
}

func (s *Service) Login(ctx context.Context, username, password, ua, ip string) (*LoginResult, error) {
	var user User
	var hash string
	var failed int
	var lockedUntil *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, username, email, role, status, quota_bytes, created_at, password_hash, failed_login_count, locked_until
		FROM users WHERE username=$1
	`, strings.TrimSpace(username)).Scan(
		&user.ID, &user.Username, &user.Email, &user.Role, &user.Status, &user.QuotaBytes, &user.CreatedAt,
		&hash, &failed, &lockedUntil,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	if user.Status != "active" {
		return nil, ErrDisabled
	}
	if lockedUntil != nil && lockedUntil.After(time.Now()) {
		return nil, ErrLocked
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		failed++
		if failed >= 5 {
			until := time.Now().Add(15 * time.Minute)
			_, _ = s.pool.Exec(ctx, `UPDATE users SET failed_login_count=$1, locked_until=$2, updated_at=now() WHERE id=$3`, failed, until, user.ID)
			return nil, ErrLocked
		}
		_, _ = s.pool.Exec(ctx, `UPDATE users SET failed_login_count=$1, updated_at=now() WHERE id=$2`, failed, user.ID)
		return nil, ErrInvalidCredentials
	}
	_, _ = s.pool.Exec(ctx, `UPDATE users SET failed_login_count=0, locked_until=NULL, updated_at=now() WHERE id=$1`, user.ID)
	return s.issueTokens(ctx, user, ua, ip)
}

func (s *Service) Refresh(ctx context.Context, refreshToken, ua, ip string) (*LoginResult, error) {
	hash := hashToken(refreshToken)
	var userID uuid.UUID
	var expiresAt time.Time
	var revoked *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash=$1
	`, hash).Scan(&userID, &expiresAt, &revoked)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	if revoked != nil || time.Now().After(expiresAt) {
		return nil, ErrInvalidCredentials
	}
	_, _ = s.pool.Exec(ctx, `UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1`, hash)

	user, err := s.GetUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user.Status != "active" {
		return nil, ErrDisabled
	}
	return s.issueTokens(ctx, *user, ua, ip)
}

func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	if refreshToken == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, hashToken(refreshToken))
	return err
}

func (s *Service) GetUser(ctx context.Context, id uuid.UUID) (*User, error) {
	var user User
	err := s.pool.QueryRow(ctx, `
		SELECT id, username, email, role, status, quota_bytes, created_at FROM users WHERE id=$1
	`, id).Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.Status, &user.QuotaBytes, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Service) ChangePassword(ctx context.Context, userID uuid.UUID, oldPwd, newPwd string) error {
	if err := validatePassword(newPwd); err != nil {
		return err
	}
	var hash string
	err := s.pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE id=$1`, userID).Scan(&hash)
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(oldPwd)) != nil {
		return ErrInvalidCredentials
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPwd), 12)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2`, string(newHash), userID)
	if err != nil {
		return err
	}
	_, _ = s.pool.Exec(ctx, `UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, userID)
	return nil
}

func (s *Service) ParseAccessToken(token string) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(token, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.accessSecret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := parsed.Claims.(*Claims)
	if !ok || !parsed.Valid {
		return nil, ErrInvalidCredentials
	}
	return claims, nil
}

func (s *Service) CreateUser(ctx context.Context, username, password, role string, quota int64) (*User, error) {
	if err := validatePassword(password); err != nil {
		return nil, err
	}
	if role != "admin" {
		role = "user"
	}
	if quota <= 0 {
		quota = s.defaultQuota
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var user User
	err = tx.QueryRow(ctx, `
		INSERT INTO users(username, password_hash, role, quota_bytes)
		VALUES($1,$2,$3,$4)
		RETURNING id, username, email, role, status, quota_bytes, created_at
	`, strings.TrimSpace(username), string(hash), role, quota).Scan(
		&user.ID, &user.Username, &user.Email, &user.Role, &user.Status, &user.QuotaBytes, &user.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO workspaces(owner_user_id, name) VALUES($1, '我的文档')`, user.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Service) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, username, email, role, status, quota_bytes, created_at FROM users ORDER BY created_at
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Role, &u.Status, &u.QuotaBytes, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Service) SetUserStatus(ctx context.Context, actorID, id uuid.UUID, status string) error {
	if status != "active" && status != "disabled" {
		return fmt.Errorf("invalid status")
	}
	if status == "disabled" && actorID == id {
		return ErrSelfDisable
	}
	if status == "disabled" {
		var role string
		if err := s.pool.QueryRow(ctx, `SELECT role FROM users WHERE id=$1`, id).Scan(&role); err != nil {
			return err
		}
		if role == "admin" {
			var n int
			if err := s.pool.QueryRow(ctx, `
				SELECT COUNT(*) FROM users WHERE role='admin' AND status='active' AND id<>$1
			`, id).Scan(&n); err != nil {
				return err
			}
			if n == 0 {
				return ErrLastAdmin
			}
		}
	}
	_, err := s.pool.Exec(ctx, `UPDATE users SET status=$1, updated_at=now() WHERE id=$2`, status, id)
	return err
}

func (s *Service) issueTokens(ctx context.Context, user User, ua, ip string) (*LoginResult, error) {
	expires := time.Now().Add(s.accessTTL)
	claims := Claims{
		UserID:   user.ID.String(),
		Username: user.Username,
		Role:     user.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expires),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   user.ID.String(),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	access, err := token.SignedString(s.accessSecret)
	if err != nil {
		return nil, err
	}

	rawRefresh, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO refresh_tokens(user_id, token_hash, user_agent, ip, expires_at)
		VALUES($1,$2,$3,$4,$5)
	`, user.ID, hashToken(rawRefresh), ua, ip, time.Now().Add(s.refreshTTL))
	if err != nil {
		return nil, err
	}

	return &LoginResult{
		AccessToken:  access,
		ExpiresAt:    expires,
		User:         user,
		RefreshToken: rawRefresh,
	}, nil
}

func validatePassword(p string) error {
	if len(p) < 8 {
		return ErrWeakPassword
	}
	return nil
}

func hashToken(t string) string {
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
