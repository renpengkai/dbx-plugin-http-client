package main

import (
	"errors"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// suggestDownloadName picks a download filename the way Postman does:
// Content-Disposition (filename* then filename), otherwise the URL's last path
// segment plus a MIME extension, otherwise "download" plus that extension.
// ".bin" is only used when nothing else identifies the file.
func suggestDownloadName(disposition, contentType, rawURL string) string {
	if name := sanitizeFileName(filenameFromContentDisposition(disposition)); name != "" {
		return withExtension(name, contentType, false)
	}
	if name := sanitizeFileName(filenameFromURL(rawURL)); name != "" {
		return withExtension(name, contentType, true)
	}
	ext := extensionForMIME(contentType)
	if ext == "" {
		ext = ".bin"
	}
	return "download" + ext
}

func filenameFromContentDisposition(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}
	if star := dispositionParam(header, "filename*"); star != "" {
		if decoded := decodeRFC5987(star); decoded != "" {
			return decoded
		}
	}
	return dispositionParam(header, "filename")
}

// dispositionParam returns one parameter. filename* is matched exactly so it
// does not collide with filename. Semicolons inside quotes are ignored.
func dispositionParam(header, name string) string {
	lowerName := strings.ToLower(name)
	rest := header
	for rest != "" {
		part, next := splitDispPart(rest)
		rest = next
		part = strings.TrimSpace(part)
		eq := strings.IndexByte(part, '=')
		if eq <= 0 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(part[:eq]))
		if key != lowerName {
			continue
		}
		return unquoteDisp(strings.TrimSpace(part[eq+1:]))
	}
	return ""
}

func splitDispPart(value string) (string, string) {
	quote := byte(0)
	for i := 0; i < len(value); i++ {
		c := value[i]
		if quote != 0 {
			if c == '\\' && i+1 < len(value) {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '"' {
			quote = c
			continue
		}
		if c == ';' {
			return value[:i], value[i+1:]
		}
	}
	return value, ""
}

func unquoteDisp(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		inner := value[1 : len(value)-1]
		inner = strings.ReplaceAll(inner, `\"`, `"`)
		inner = strings.ReplaceAll(inner, `\\`, `\`)
		return inner
	}
	return value
}

// decodeRFC5987 accepts charset'language'percent-encoded-value (RFC 5987).
func decodeRFC5987(value string) string {
	value = strings.TrimSpace(value)
	parts := strings.SplitN(value, "'", 3)
	encoded := value
	if len(parts) == 3 {
		encoded = parts[2]
	}
	decoded, err := url.PathUnescape(encoded)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return ""
	}
	return decoded
}

func filenameFromURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	cleaned := path.Clean(parsed.Path)
	if cleaned == "." || cleaned == "/" || cleaned == "" {
		return ""
	}
	segment := path.Base(cleaned)
	if segment == "." || segment == "/" || segment == "" {
		return ""
	}
	decoded, err := url.PathUnescape(segment)
	if err != nil {
		return segment
	}
	return decoded
}

func withExtension(name, contentType string, replaceGeneric bool) string {
	ext := extensionForMIME(contentType)
	current := filepath.Ext(name)
	if current == "" {
		if ext == "" {
			return name + ".bin"
		}
		return name + ext
	}
	if replaceGeneric && genericDownloadExt[strings.ToLower(current)] && ext != "" {
		return strings.TrimSuffix(name, current) + ext
	}
	return name
}

func extensionForMIME(contentType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if base == "" || base == "application/octet-stream" {
		return ""
	}
	if ext, ok := mimeExtensions[base]; ok {
		return ext
	}
	if strings.HasPrefix(base, "text/") {
		return textSubtypeExt(strings.TrimPrefix(base, "text/"))
	}
	return ""
}

func textSubtypeExt(sub string) string {
	if sub == "plain" {
		return ".txt"
	}
	var builder strings.Builder
	for _, r := range sub {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
		}
	}
	if builder.Len() == 0 {
		return ".txt"
	}
	return "." + builder.String()
}

func sanitizeFileName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\\", "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		value = value[index+1:]
	}
	if index := strings.IndexAny(value, "?#"); index >= 0 {
		value = value[:index]
	}
	value = strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune("<>:\"|?*", r) {
			return -1
		}
		return r
	}, value)
	value = strings.Trim(value, " .")
	if value == "" || value == "." || value == ".." {
		return ""
	}
	if reservedFileName(value) {
		value = "_" + value
	}
	if len(value) > 180 {
		ext := filepath.Ext(value)
		base := value
		if len(ext) < len(value) {
			base = value[:len(value)-len(ext)]
		}
		keep := 180 - len(ext)
		if keep < 1 {
			keep = 1
		}
		if len(base) > keep {
			base = base[:keep]
		}
		value = strings.TrimRight(base, " .") + ext
	}
	return value
}

func reservedFileName(value string) bool {
	base := strings.ToUpper(strings.TrimSuffix(value, filepath.Ext(value)))
	switch base {
	case "CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return true
	default:
		return false
	}
}

// uniquePath avoids silently overwriting an existing download.
func uniquePath(directory, name string) string {
	target := filepath.Join(directory, name)
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		return target
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for index := 1; index < 1000; index++ {
		candidate := filepath.Join(directory, strings.TrimSpace(base)+" ("+itoa(index)+")"+ext)
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
	return target
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := [4]byte{}
	pos := len(digits)
	for value > 0 {
		pos--
		digits[pos] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[pos:])
}

var genericDownloadExt = map[string]bool{
	".bin":      true,
	".dat":      true,
	".download": true,
	".dms":      true,
	".part":     true,
}

var mimeExtensions = map[string]string{
	"application/pdf":              ".pdf",
	"application/zip":              ".zip",
	"application/x-zip-compressed": ".zip",
	"image/png":                    ".png",
	"image/jpeg":                   ".jpg",
	"image/jpg":                    ".jpg",
	"image/gif":                    ".gif",
	"image/webp":                   ".webp",
	"image/svg+xml":                ".svg",
	"image/bmp":                    ".bmp",
	"image/x-icon":                 ".ico",
	"application/json":             ".json",
	"text/json":                    ".json",
	"text/csv":                     ".csv",
	"application/csv":              ".csv",
	"application/vnd.ms-excel":     ".xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":       ".xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
	"application/msword":            ".doc",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"text/html":              ".html",
	"text/plain":             ".txt",
	"text/css":               ".css",
	"text/xml":               ".xml",
	"application/xml":        ".xml",
	"application/javascript": ".js",
	"text/javascript":        ".js",
	"application/gzip":       ".gz",
	"application/x-gzip":     ".gz",
	"application/x-tar":      ".tar",
	"application/wasm":       ".wasm",
	"audio/mpeg":             ".mp3",
	"audio/wav":              ".wav",
	"video/mp4":              ".mp4",
	"application/xhtml+xml":  ".xhtml",
}
