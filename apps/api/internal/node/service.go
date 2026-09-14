package node

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/weidoc/weidoc/apps/api/internal/storage"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrConflict      = errors.New("name conflict")
	ErrInvalidName   = errors.New("invalid name")
	ErrForbiddenExt  = errors.New("extension not allowed")
	ErrInvalidContent = errors.New("文件内容与扩展名不符，可能是伪造或损坏的文件")
	ErrTypeMismatch  = errors.New("请选择与当前文件同类的格式（如 Word 导入 doc/docx）")
	ErrInvalidMove   = errors.New("invalid move")
	ErrNotOwner      = errors.New("not workspace owner")
	ErrQuotaExceeded = errors.New("quota exceeded")
	ErrLocked        = errors.New("file locked by another user")
)

type Service struct {
	pool    *pgxpool.Pool
	store   *storage.Local
	allowed map[string]struct{}
	maxSize int64
}

type Node struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Type        string     `json:"type"`
	Name        string     `json:"name"`
	Ext         string     `json:"ext"`
	SizeBytes   int64      `json:"size_bytes"`
	Mime        *string    `json:"mime,omitempty"`
	IsStarred   bool       `json:"is_starred"`
	Version     int        `json:"version"`
	EditorKey   *string    `json:"editor_key,omitempty"`
	SortOrder   int        `json:"sort_order"`
	DeletedAt   *time.Time `json:"deleted_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	StorageKey  *string    `json:"-"`
	ContentHash *string    `json:"content_hash,omitempty"`
}

type Workspace struct {
	ID          uuid.UUID `json:"id"`
	OwnerUserID uuid.UUID `json:"owner_user_id"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
}

func NewService(pool *pgxpool.Pool, store *storage.Local, allowed map[string]struct{}, maxSize int64) *Service {
	return &Service{pool: pool, store: store, allowed: allowed, maxSize: maxSize}
}

func (s *Service) ListWorkspaces(ctx context.Context, userID uuid.UUID) ([]Workspace, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, owner_user_id, name, created_at FROM workspaces WHERE owner_user_id=$1 ORDER BY created_at
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Workspace
	for rows.Next() {
		var w Workspace
		if err := rows.Scan(&w.ID, &w.OwnerUserID, &w.Name, &w.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *Service) EnsureOwner(ctx context.Context, workspaceID, userID uuid.UUID) error {
	var owner uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspaces WHERE id=$1`, workspaceID).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if owner != userID {
		return ErrNotOwner
	}
	return nil
}

func (s *Service) ListChildren(ctx context.Context, workspaceID uuid.UUID, parentID *uuid.UUID) ([]Node, error) {
	var rows pgx.Rows
	var err error
	if parentID == nil {
		rows, err = s.pool.Query(ctx, `
			SELECT id, workspace_id, parent_id, type, name, ext, size_bytes, mime, is_starred, version, editor_key,
			       deleted_at, created_at, updated_at, storage_key, content_hash, sort_order
			FROM nodes
			WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL
			ORDER BY sort_order ASC, CASE WHEN type='folder' THEN 0 ELSE 1 END, name COLLATE "C"
		`, workspaceID)
	} else {
		rows, err = s.pool.Query(ctx, `
			SELECT id, workspace_id, parent_id, type, name, ext, size_bytes, mime, is_starred, version, editor_key,
			       deleted_at, created_at, updated_at, storage_key, content_hash, sort_order
			FROM nodes
			WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL
			ORDER BY sort_order ASC, CASE WHEN type='folder' THEN 0 ELSE 1 END, name COLLATE "C"
		`, workspaceID, *parentID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNodes(rows)
}

func (s *Service) Get(ctx context.Context, workspaceID, id uuid.UUID) (*Node, error) {
	n, err := s.scanOne(ctx, `
		SELECT id, workspace_id, parent_id, type, name, ext, size_bytes, mime, is_starred, version, editor_key,
		       deleted_at, created_at, updated_at, storage_key, content_hash, sort_order
		FROM nodes WHERE workspace_id=$1 AND id=$2
	`, workspaceID, id)
	if err != nil {
		return nil, err
	}
	return n, nil
}

func (s *Service) CreateFolder(ctx context.Context, workspaceID, userID uuid.UUID, parentID *uuid.UUID, name string) (*Node, error) {
	name, err := sanitizeName(name)
	if err != nil {
		return nil, err
	}
	return s.insertNode(ctx, workspaceID, userID, parentID, "folder", name, "", 0, nil, nil, nil)
}

func (s *Service) CreateFile(ctx context.Context, workspaceID, userID uuid.UUID, parentID *uuid.UUID, name string, content []byte) (*Node, error) {
	name, err := sanitizeName(name)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	if !s.extAllowed(ext) {
		return nil, ErrForbiddenExt
	}
	if err := ValidateFileContent(ext, content); err != nil {
		return nil, err
	}
	if int64(len(content)) > s.maxSize {
		return nil, fmt.Errorf("file too large")
	}
	if err := s.checkQuota(ctx, userID, int64(len(content))); err != nil {
		return nil, err
	}

	nodeID := uuid.New()
	tmpHash := fmt.Sprintf("%x", content)
	if len(tmpHash) > 16 {
		tmpHash = tmpHash[:16]
	}
	key := storage.MakeStorageKey(workspaceID.String(), nodeID.String(), 1, fmt.Sprintf("%x", sha256Sum(content)))
	hash, size, err := s.store.PutBytes(key, content)
	if err != nil {
		return nil, err
	}
	mimeType := mime.TypeByExtension("." + ext)
	n, err := s.insertNodeWithID(ctx, nodeID, workspaceID, userID, parentID, "file", name, ext, size, &mimeType, &key, &hash)
	if err != nil {
		_ = s.store.Delete(key)
		return nil, err
	}
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO file_versions(node_id, version, storage_key, size_bytes, content_hash, created_by, remark)
		VALUES($1,1,$2,$3,$4,$5,'create')
	`, n.ID, key, size, hash, userID)
	if ext == "md" || ext == "markdown" || ext == "txt" {
		_, _ = s.pool.Exec(ctx, `INSERT INTO md_search(node_id, content) VALUES($1,$2) ON CONFLICT (node_id) DO UPDATE SET content=EXCLUDED.content`, n.ID, string(content))
	}
	return n, nil
}

func (s *Service) Upload(ctx context.Context, workspaceID, userID uuid.UUID, parentID *uuid.UUID, filename string, r io.Reader, sizeHint int64) (*Node, error) {
	name, err := sanitizeName(filename)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	if !s.extAllowed(ext) {
		return nil, ErrForbiddenExt
	}
	if sizeHint > s.maxSize {
		return nil, fmt.Errorf("file too large")
	}
	data, err := io.ReadAll(io.LimitReader(r, s.maxSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > s.maxSize {
		return nil, fmt.Errorf("file too large")
	}
	return s.CreateFile(ctx, workspaceID, userID, parentID, name, data)
}

func fileFamily(ext string) string {
	switch strings.ToLower(ext) {
	case "md", "markdown":
		return "md"
	case "txt", "json", "yaml", "yml":
		return "text"
	case "doc", "docx":
		return "word"
	case "xls", "xlsx", "csv":
		return "excel"
	case "ppt", "pptx":
		return "ppt"
	case "pdf":
		return "pdf"
	case "png", "jpg", "jpeg", "gif", "webp", "svg":
		return "image"
	default:
		return strings.ToLower(ext)
	}
}

// ImportInto 用本地文件内容覆盖已有节点（同类扩展名），用于「导入到当前文件」。
func (s *Service) ImportInto(ctx context.Context, workspaceID, userID, id uuid.UUID, filename string, r io.Reader, sizeHint int64) (*Node, error) {
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return nil, err
	}
	if n.Type != "file" {
		return nil, ErrNotFound
	}
	name, err := sanitizeName(filename)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	if !s.extAllowed(ext) {
		return nil, ErrForbiddenExt
	}
	if fileFamily(n.Ext) != fileFamily(ext) {
		return nil, ErrTypeMismatch
	}
	if sizeHint > s.maxSize {
		return nil, fmt.Errorf("file too large")
	}
	data, err := io.ReadAll(io.LimitReader(r, s.maxSize+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > s.maxSize {
		return nil, fmt.Errorf("file too large")
	}
	if err := ValidateFileContent(n.Ext, data); err != nil {
		return nil, err
	}
	return s.SaveContent(ctx, workspaceID, userID, id, data, n.Version)
}

func (s *Service) ReadContent(ctx context.Context, workspaceID, id uuid.UUID) ([]byte, *Node, error) {
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return nil, nil, err
	}
	if n.Type != "file" || n.StorageKey == nil {
		return nil, nil, ErrNotFound
	}
	b, err := s.store.ReadAll(*n.StorageKey)
	if err != nil {
		return nil, nil, err
	}
	return b, n, nil
}

func (s *Service) SaveContent(ctx context.Context, workspaceID, userID, id uuid.UUID, content []byte, expectedVersion int) (*Node, error) {
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return nil, err
	}
	if n.Type != "file" {
		return nil, ErrNotFound
	}
	if expectedVersion > 0 && n.Version != expectedVersion {
		return nil, ErrConflict
	}
	if err := s.checkQuota(ctx, userID, int64(len(content))-n.SizeBytes); err != nil {
		return nil, err
	}
	newVersion := n.Version + 1
	hash := fmt.Sprintf("%x", sha256Sum(content))
	key := storage.MakeStorageKey(workspaceID.String(), id.String(), newVersion, hash)
	h, size, err := s.store.PutBytes(key, content)
	if err != nil {
		return nil, err
	}
	editorKey := newEditorKey(id, newVersion)
	_, err = s.pool.Exec(ctx, `
		UPDATE nodes SET storage_key=$1, content_hash=$2, size_bytes=$3, version=$4, editor_key=$5,
		updated_by=$6, updated_at=now()
		WHERE id=$7 AND workspace_id=$8
	`, key, h, size, newVersion, editorKey, userID, id, workspaceID)
	if err != nil {
		return nil, err
	}
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO file_versions(node_id, version, storage_key, size_bytes, content_hash, created_by, remark)
		VALUES($1,$2,$3,$4,$5,$6,'save')
	`, id, newVersion, key, size, h, userID)
	if n.Ext == "md" || n.Ext == "markdown" || n.Ext == "txt" {
		_, _ = s.pool.Exec(ctx, `INSERT INTO md_search(node_id, content) VALUES($1,$2) ON CONFLICT (node_id) DO UPDATE SET content=EXCLUDED.content`, id, string(content))
	}
	return s.Get(ctx, workspaceID, id)
}

func (s *Service) Rename(ctx context.Context, workspaceID, userID, id uuid.UUID, name string) (*Node, error) {
	name, err := sanitizeName(name)
	if err != nil {
		return nil, err
	}
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return nil, err
	}
	ext := n.Ext
	if n.Type == "file" {
		ext = strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
		if !s.extAllowed(ext) {
			return nil, ErrForbiddenExt
		}
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE nodes SET name=$1, ext=$2, updated_by=$3, updated_at=now() WHERE id=$4 AND workspace_id=$5 AND deleted_at IS NULL
	`, name, ext, userID, id, workspaceID)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.Get(ctx, workspaceID, id)
}

func (s *Service) Move(ctx context.Context, workspaceID, userID uuid.UUID, ids []uuid.UUID, targetParent *uuid.UUID, beforeID *uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	if targetParent != nil {
		t, err := s.Get(ctx, workspaceID, *targetParent)
		if err != nil {
			return err
		}
		if t.Type != "folder" {
			return ErrInvalidMove
		}
	}
	for _, id := range ids {
		if targetParent != nil {
			ok, err := s.isDescendant(ctx, workspaceID, *targetParent, id)
			if err != nil {
				return err
			}
			if ok || *targetParent == id {
				return ErrInvalidMove
			}
		}
		if beforeID != nil && *beforeID == id {
			return ErrInvalidMove
		}
	}
	if beforeID != nil {
		anchor, err := s.Get(ctx, workspaceID, *beforeID)
		if err != nil {
			return err
		}
		// before 目标必须与目标父级一致
		sameParent := (anchor.ParentID == nil && targetParent == nil) ||
			(anchor.ParentID != nil && targetParent != nil && *anchor.ParentID == *targetParent)
		if !sameParent {
			return ErrInvalidMove
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, id := range ids {
		_, err := tx.Exec(ctx, `
			UPDATE nodes SET parent_id=$1, updated_by=$2, updated_at=now()
			WHERE id=$3 AND workspace_id=$4 AND deleted_at IS NULL
		`, targetParent, userID, id, workspaceID)
		if err != nil {
			if isUniqueViolation(err) {
				return ErrConflict
			}
			return err
		}
	}

	// 重排目标目录下的顺序
	var rows pgx.Rows
	if targetParent == nil {
		rows, err = tx.Query(ctx, `
			SELECT id FROM nodes
			WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL
			ORDER BY sort_order ASC, created_at ASC
		`, workspaceID)
	} else {
		rows, err = tx.Query(ctx, `
			SELECT id FROM nodes
			WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL
			ORDER BY sort_order ASC, created_at ASC
		`, workspaceID, *targetParent)
	}
	if err != nil {
		return err
	}
	moving := map[uuid.UUID]bool{}
	for _, id := range ids {
		moving[id] = true
	}
	var rest []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if moving[id] {
			continue
		}
		rest = append(rest, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	insertAt := len(rest)
	if beforeID != nil {
		insertAt = len(rest)
		for i, id := range rest {
			if id == *beforeID {
				insertAt = i
				break
			}
		}
	}
	ordered := append([]uuid.UUID{}, rest[:insertAt]...)
	ordered = append(ordered, ids...)
	ordered = append(ordered, rest[insertAt:]...)

	for i, id := range ordered {
		if _, err := tx.Exec(ctx, `UPDATE nodes SET sort_order=$1 WHERE id=$2 AND workspace_id=$3`, (i+1)*10, id, workspaceID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Service) SoftDelete(ctx context.Context, workspaceID, userID, id uuid.UUID) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE nodes SET deleted_at=now(), updated_by=$1, updated_at=now()
		WHERE id=$2 AND workspace_id=$3 AND deleted_at IS NULL
	`, userID, id, workspaceID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Service) ListTrash(ctx context.Context, workspaceID uuid.UUID) ([]Node, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, workspace_id, parent_id, type, name, ext, size_bytes, mime, is_starred, version, editor_key,
		       deleted_at, created_at, updated_at, storage_key, content_hash, sort_order
		FROM nodes WHERE workspace_id=$1 AND deleted_at IS NOT NULL
		ORDER BY deleted_at DESC
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNodes(rows)
}

func (s *Service) Restore(ctx context.Context, workspaceID, userID, id uuid.UUID) (*Node, error) {
	_, err := s.pool.Exec(ctx, `
		UPDATE nodes SET deleted_at=NULL, updated_by=$1, updated_at=now()
		WHERE id=$2 AND workspace_id=$3 AND deleted_at IS NOT NULL
	`, userID, id, workspaceID)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.Get(ctx, workspaceID, id)
}

func (s *Service) HardDelete(ctx context.Context, workspaceID, id uuid.UUID) error {
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM nodes WHERE id=$1 AND workspace_id=$2`, id, workspaceID)
	if err != nil {
		return err
	}
	if n.StorageKey != nil {
		_ = s.store.Delete(*n.StorageKey)
	}
	return nil
}

func (s *Service) Copy(ctx context.Context, workspaceID, userID, id uuid.UUID) (*Node, error) {
	n, err := s.Get(ctx, workspaceID, id)
	if err != nil {
		return nil, err
	}
	newName := copyName(n.Name)
	if n.Type == "folder" {
		return s.CreateFolder(ctx, workspaceID, userID, n.ParentID, newName)
	}
	if n.StorageKey == nil {
		return nil, ErrNotFound
	}
	data, err := s.store.ReadAll(*n.StorageKey)
	if err != nil {
		return nil, err
	}
	return s.CreateFile(ctx, workspaceID, userID, n.ParentID, newName, data)
}

func (s *Service) Breadcrumb(ctx context.Context, workspaceID, id uuid.UUID) ([]Node, error) {
	var chain []Node
	cur := &id
	for cur != nil {
		n, err := s.Get(ctx, workspaceID, *cur)
		if err != nil {
			return nil, err
		}
		chain = append([]Node{*n}, chain...)
		cur = n.ParentID
	}
	return chain, nil
}

func (s *Service) Search(ctx context.Context, workspaceID uuid.UUID, q string) ([]Node, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return []Node{}, nil
	}
	if len(q) > 100 {
		q = q[:100]
	}
	q = likeEscape(q)
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT n.id, n.workspace_id, n.parent_id, n.type, n.name, n.ext, n.size_bytes, n.mime, n.is_starred,
		       n.version, n.editor_key, n.deleted_at, n.created_at, n.updated_at, n.storage_key, n.content_hash, n.sort_order
		FROM nodes n
		LEFT JOIN md_search m ON m.node_id = n.id
		WHERE n.workspace_id=$1 AND n.deleted_at IS NULL
		  AND (n.name ILIKE '%'||$2||'%' ESCAPE '\' OR m.content ILIKE '%'||$2||'%' ESCAPE '\')
		ORDER BY n.updated_at DESC
		LIMIT 100
	`, workspaceID, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNodes(rows)
}

func (s *Service) TouchRecent(ctx context.Context, userID, nodeID uuid.UUID) {
	_, _ = s.pool.Exec(ctx, `
		INSERT INTO recent_opens(user_id, node_id, opened_at) VALUES($1,$2,now())
		ON CONFLICT (user_id, node_id) DO UPDATE SET opened_at=now()
	`, userID, nodeID)
}

func (s *Service) ListRecent(ctx context.Context, userID uuid.UUID, limit int) ([]Node, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `
		SELECT n.id, n.workspace_id, n.parent_id, n.type, n.name, n.ext, n.size_bytes, n.mime, n.is_starred,
		       n.version, n.editor_key, n.deleted_at, n.created_at, n.updated_at, n.storage_key, n.content_hash, n.sort_order
		FROM recent_opens r
		JOIN nodes n ON n.id = r.node_id
		WHERE r.user_id=$1 AND n.deleted_at IS NULL
		ORDER BY r.opened_at DESC
		LIMIT $2
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanNodes(rows)
}

func (s *Service) AcquireLock(ctx context.Context, nodeID, userID uuid.UUID, session string, ttl time.Duration) error {
	var existingUser uuid.UUID
	var lease time.Time
	err := s.pool.QueryRow(ctx, `SELECT user_id, lease_until FROM edit_locks WHERE node_id=$1`, nodeID).Scan(&existingUser, &lease)
	if err == nil {
		if existingUser != userID && lease.After(time.Now()) {
			return ErrLocked
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO edit_locks(node_id, user_id, lease_until, editor_session)
		VALUES($1,$2,$3,$4)
		ON CONFLICT (node_id) DO UPDATE SET user_id=$2, lease_until=$3, editor_session=$4
	`, nodeID, userID, time.Now().Add(ttl), session)
	return err
}

func (s *Service) RenewLock(ctx context.Context, nodeID, userID uuid.UUID, ttl time.Duration) error {
	ct, err := s.pool.Exec(ctx, `
		UPDATE edit_locks SET lease_until=$1 WHERE node_id=$2 AND user_id=$3
	`, time.Now().Add(ttl), nodeID, userID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrLocked
	}
	return nil
}

func (s *Service) ReleaseLock(ctx context.Context, nodeID, userID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM edit_locks WHERE node_id=$1 AND user_id=$2`, nodeID, userID)
	return err
}

func (s *Service) UpdateAfterOfficeSave(ctx context.Context, workspaceID, nodeID, userID uuid.UUID, data []byte) (*Node, error) {
	return s.SaveContent(ctx, workspaceID, userID, nodeID, data, 0)
}

func (s *Service) SetEditorKey(ctx context.Context, nodeID uuid.UUID, key string) error {
	_, err := s.pool.Exec(ctx, `UPDATE nodes SET editor_key=$1 WHERE id=$2`, key, nodeID)
	return err
}

func (s *Service) insertNode(ctx context.Context, workspaceID, userID uuid.UUID, parentID *uuid.UUID, typ, name, ext string, size int64, mime, key, hash *string) (*Node, error) {
	return s.insertNodeWithID(ctx, uuid.New(), workspaceID, userID, parentID, typ, name, ext, size, mime, key, hash)
}

func (s *Service) insertNodeWithID(ctx context.Context, id, workspaceID, userID uuid.UUID, parentID *uuid.UUID, typ, name, ext string, size int64, mime, key, hash *string) (*Node, error) {
	editorKey := newEditorKey(id, 1)
	var nextOrder int
	if parentID == nil {
		_ = s.pool.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order),0)+10 FROM nodes
			WHERE workspace_id=$1 AND parent_id IS NULL AND deleted_at IS NULL
		`, workspaceID).Scan(&nextOrder)
	} else {
		_ = s.pool.QueryRow(ctx, `
			SELECT COALESCE(MAX(sort_order),0)+10 FROM nodes
			WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL
		`, workspaceID, *parentID).Scan(&nextOrder)
	}
	if nextOrder <= 0 {
		nextOrder = 10
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO nodes(id, workspace_id, parent_id, type, name, ext, size_bytes, mime, storage_key, content_hash, version, editor_key, created_by, updated_by, sort_order)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,$12,$13)
	`, id, workspaceID, parentID, typ, name, ext, size, mime, key, hash, editorKey, userID, nextOrder)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	return s.Get(ctx, workspaceID, id)
}

func (s *Service) checkQuota(ctx context.Context, userID uuid.UUID, delta int64) error {
	if delta <= 0 {
		return nil
	}
	var quota, used int64
	err := s.pool.QueryRow(ctx, `
		SELECT u.quota_bytes,
		       COALESCE((
		         SELECT SUM(n.size_bytes) FROM nodes n
		         JOIN workspaces w ON w.id=n.workspace_id
		         WHERE w.owner_user_id=$1 AND n.deleted_at IS NULL AND n.type='file'
		       ),0)
		FROM users u WHERE u.id=$1
	`, userID).Scan(&quota, &used)
	if err != nil {
		return err
	}
	if used+delta > quota {
		return ErrQuotaExceeded
	}
	return nil
}

func (s *Service) extAllowed(ext string) bool {
	if ext == "" {
		return false
	}
	_, ok := s.allowed[ext]
	return ok
}

func (s *Service) isDescendant(ctx context.Context, workspaceID, maybeChild, ancestor uuid.UUID) (bool, error) {
	cur := &maybeChild
	for cur != nil {
		if *cur == ancestor {
			return true, nil
		}
		n, err := s.Get(ctx, workspaceID, *cur)
		if err != nil {
			return false, err
		}
		cur = n.ParentID
	}
	return false, nil
}

func (s *Service) scanOne(ctx context.Context, q string, args ...any) (*Node, error) {
	row := s.pool.QueryRow(ctx, q, args...)
	var n Node
	err := row.Scan(
		&n.ID, &n.WorkspaceID, &n.ParentID, &n.Type, &n.Name, &n.Ext, &n.SizeBytes, &n.Mime, &n.IsStarred,
		&n.Version, &n.EditorKey, &n.DeletedAt, &n.CreatedAt, &n.UpdatedAt, &n.StorageKey, &n.ContentHash, &n.SortOrder,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &n, nil
}

func scanNodes(rows pgx.Rows) ([]Node, error) {
	var out []Node
	for rows.Next() {
		var n Node
		if err := rows.Scan(
			&n.ID, &n.WorkspaceID, &n.ParentID, &n.Type, &n.Name, &n.Ext, &n.SizeBytes, &n.Mime, &n.IsStarred,
			&n.Version, &n.EditorKey, &n.DeletedAt, &n.CreatedAt, &n.UpdatedAt, &n.StorageKey, &n.ContentHash, &n.SortOrder,
		); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	if out == nil {
		out = []Node{}
	}
	return out, rows.Err()
}

func sanitizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || !utf8.ValidString(name) {
		return "", ErrInvalidName
	}
	if strings.ContainsAny(name, `\/:*?"<>|`) {
		return "", ErrInvalidName
	}
	if name == "." || name == ".." {
		return "", ErrInvalidName
	}
	return name, nil
}

func copyName(name string) string {
	ext := path.Ext(name)
	base := strings.TrimSuffix(name, ext)
	return base + " (副本)" + ext
}

func newEditorKey(id uuid.UUID, version int) string {
	return fmt.Sprintf("%s_%d_%d", strings.ReplaceAll(id.String(), "-", ""), version, time.Now().Unix())
}

func sha256Sum(b []byte) [32]byte {
	return storageSHA256(b)
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "nodes_unique_name_active")
}

func likeEscape(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}
