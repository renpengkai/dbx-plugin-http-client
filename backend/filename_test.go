package main

import "testing"

func TestSuggestDownloadName(t *testing.T) {
	cases := []struct {
		name        string
		disposition string
		contentType string
		rawURL      string
		want        string
	}{
		{
			name:        "filename quoted pdf",
			disposition: `attachment; filename="report.pdf"`,
			contentType: "application/pdf",
			rawURL:      "https://cdn.example.com/download",
			want:        "report.pdf",
		},
		{
			name:        "filename unquoted",
			disposition: `attachment; filename=report.pdf`,
			contentType: "application/pdf",
			want:        "report.pdf",
		},
		{
			name:        "filename star preferred over filename",
			disposition: `attachment; filename="fallback.xlsx"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E8%A1%A8.xlsx`,
			contentType: "application/octet-stream",
			rawURL:      "https://example.com/export",
			want:        "季度报表.xlsx",
		},
		{
			name:        "rfc5987 with language tag",
			disposition: `inline; filename*=utf-8'en'%E6%8A%A5%E5%91%8A.pdf`,
			contentType: "application/pdf",
			want:        "报告.pdf",
		},
		{
			name:        "filename star quoted",
			disposition: `attachment; filename*="UTF-8''file%20name.zip"`,
			contentType: "application/zip",
			want:        "file name.zip",
		},
		{
			name:        "disposition without extension gets mime",
			disposition: `attachment; filename="quarterly"`,
			contentType: "application/pdf",
			want:        "quarterly.pdf",
		},
		{
			name:        "disposition bin kept when server named it",
			disposition: `attachment; filename="payload.bin"`,
			contentType: "application/pdf",
			want:        "payload.bin",
		},
		{
			name:        "url pdf",
			contentType: "application/pdf",
			rawURL:      "https://cdn.example.com/files/report.pdf?token=1",
			want:        "report.pdf",
		},
		{
			name:        "url segment plus jpeg",
			contentType: "image/jpeg",
			rawURL:      "https://cdn.example.com/files/photo",
			want:        "photo.jpg",
		},
		{
			name:        "url png keeps case",
			contentType: "image/png",
			rawURL:      "https://cdn.example.com/a/b/photo.PNG",
			want:        "photo.PNG",
		},
		{
			name:        "url csv",
			contentType: "text/csv; charset=utf-8",
			rawURL:      "https://example.com/export/data",
			want:        "data.csv",
		},
		{
			name:        "url json",
			contentType: "application/json; charset=utf-8",
			rawURL:      "https://api.example.com/v1/users",
			want:        "users.json",
		},
		{
			name:        "url zip octet-stream keeps url extension",
			contentType: "application/octet-stream",
			rawURL:      "https://example.com/dl/archive.zip",
			want:        "archive.zip",
		},
		{
			name:        "generic bin replaced from mime when name comes from url",
			contentType: "application/zip",
			rawURL:      "https://example.com/dl/archive.bin",
			want:        "archive.zip",
		},
		{
			name:        "xlsx mime",
			contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			rawURL:      "https://example.com/dl/sheet",
			want:        "sheet.xlsx",
		},
		{
			name:        "trailing slash uses last segment",
			contentType: "application/pdf",
			rawURL:      "https://example.com/download/",
			want:        "download.pdf",
		},
		{
			name:        "no clues falls back to download bin",
			contentType: "application/octet-stream",
			rawURL:      "https://example.com/",
			want:        "download.bin",
		},
		{
			name:        "mime only default name",
			contentType: "application/pdf",
			rawURL:      "https://example.com/",
			want:        "download.pdf",
		},
		{
			name:        "html charset",
			contentType: "text/html; charset=utf-8",
			rawURL:      "https://example.com/docs/page",
			want:        "page.html",
		},
		{
			name:        "path traversal stripped",
			disposition: `attachment; filename="../../etc/passwd"`,
			contentType: "text/plain",
			want:        "passwd.txt",
		},
		{
			name:        "quote stripped from filename",
			disposition: `attachment; filename="a\"b.csv"`,
			contentType: "text/csv",
			want:        "ab.csv",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := suggestDownloadName(tc.disposition, tc.contentType, tc.rawURL)
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeFileNameReserved(t *testing.T) {
	if got := sanitizeFileName("CON.txt"); got != "_CON.txt" {
		t.Fatalf("got %q", got)
	}
	if got := sanitizeFileName(".."); got != "" {
		t.Fatalf("got %q", got)
	}
}
