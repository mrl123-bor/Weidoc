package templates

import (
	"embed"
	"fmt"
)

//go:embed files/empty.docx files/empty.xlsx files/empty.pptx files/empty.pdf
var files embed.FS

func EmptyDocx() []byte {
	b, err := files.ReadFile("files/empty.docx")
	if err != nil {
		panic(err)
	}
	return b
}

func EmptyXlsx() []byte {
	b, err := files.ReadFile("files/empty.xlsx")
	if err != nil {
		panic(err)
	}
	return b
}

func EmptyPptx() []byte {
	b, err := files.ReadFile("files/empty.pptx")
	if err != nil {
		panic(err)
	}
	return b
}

func EmptyPdf() []byte {
	b, err := files.ReadFile("files/empty.pdf")
	if err != nil {
		panic(err)
	}
	return b
}

func ByExt(ext string) ([]byte, error) {
	switch ext {
	case "docx":
		return EmptyDocx(), nil
	case "xlsx":
		return EmptyXlsx(), nil
	case "pptx":
		return EmptyPptx(), nil
	case "pdf":
		return EmptyPdf(), nil
	case "md", "markdown":
		return []byte("# 未命名笔记\n\n"), nil
	case "txt":
		return []byte(""), nil
	default:
		return nil, fmt.Errorf("no template for %s", ext)
	}
}
