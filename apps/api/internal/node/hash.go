package node

import (
	"crypto/sha256"
)

func storageSHA256(b []byte) [32]byte {
	return sha256.Sum256(b)
}
