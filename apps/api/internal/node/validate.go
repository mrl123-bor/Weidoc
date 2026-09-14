package node

import (
	"bytes"
	"strings"
)

// ValidateFileContent checks magic bytes / structure so fake extensions
// (e.g. text renamed to .xlsx) cannot be opened by OnlyOffice as CSV.
func ValidateFileContent(ext string, data []byte) error {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	switch ext {
	case "docx", "xlsx", "pptx":
		// OOXML is a ZIP package
		if len(data) < 4 || data[0] != 'P' || data[1] != 'K' {
			return ErrInvalidContent
		}
	case "pdf":
		if len(data) < 5 || !bytes.HasPrefix(data, []byte("%PDF-")) {
			return ErrInvalidContent
		}
	case "png":
		sig := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
		if len(data) < len(sig) || !bytes.HasPrefix(data, sig) {
			return ErrInvalidContent
		}
	case "jpg", "jpeg":
		if len(data) < 3 || data[0] != 0xff || data[1] != 0xd8 || data[2] != 0xff {
			return ErrInvalidContent
		}
	case "gif":
		if len(data) < 6 || (!bytes.HasPrefix(data, []byte("GIF87a")) && !bytes.HasPrefix(data, []byte("GIF89a"))) {
			return ErrInvalidContent
		}
	case "webp":
		if len(data) < 12 || !bytes.HasPrefix(data, []byte("RIFF")) || string(data[8:12]) != "WEBP" {
			return ErrInvalidContent
		}
	case "svg":
		lower := bytes.ToLower(data)
		if !bytes.Contains(lower, []byte("<svg")) {
			return ErrInvalidContent
		}
	}
	return nil
}
