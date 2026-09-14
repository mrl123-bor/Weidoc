package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type Local struct {
	Root string
}

func NewLocal(root string) (*Local, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "blobs"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(root, "templates"), 0o755); err != nil {
		return nil, err
	}
	return &Local{Root: root}, nil
}

func (l *Local) BlobPath(storageKey string) string {
	return filepath.Join(l.Root, "blobs", filepath.FromSlash(storageKey))
}

func (l *Local) Put(storageKey string, r io.Reader) (hash string, size int64, err error) {
	path := l.BlobPath(storageKey)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", 0, err
	}
	f, err := os.Create(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), r)
	if err != nil {
		_ = os.Remove(path)
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func (l *Local) PutBytes(storageKey string, data []byte) (hash string, size int64, err error) {
	return l.Put(storageKey, newBytesReader(data))
}

func (l *Local) Open(storageKey string) (*os.File, error) {
	return os.Open(l.BlobPath(storageKey))
}

func (l *Local) ReadAll(storageKey string) ([]byte, error) {
	return os.ReadFile(l.BlobPath(storageKey))
}

func (l *Local) Copy(srcKey, dstKey string) error {
	src, err := l.Open(srcKey)
	if err != nil {
		return err
	}
	defer src.Close()
	_, _, err = l.Put(dstKey, src)
	return err
}

func (l *Local) Delete(storageKey string) error {
	err := os.Remove(l.BlobPath(storageKey))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func (l *Local) Exists(storageKey string) bool {
	_, err := os.Stat(l.BlobPath(storageKey))
	return err == nil
}

func MakeStorageKey(workspaceID, nodeID string, version int, hash string) string {
	short := hash
	if len(short) > 16 {
		short = short[:16]
	}
	return fmt.Sprintf("%s/%s/%d_%s.bin", workspaceID, nodeID, version, short)
}

type bytesReader struct {
	b []byte
	i int
}

func newBytesReader(b []byte) *bytesReader { return &bytesReader{b: b} }

func (r *bytesReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}
