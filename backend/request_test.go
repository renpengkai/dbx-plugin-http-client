package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"mime"
	"mime/multipart"
	"strings"
	"testing"
)

func TestBuildMultipartMixedTextAndFile(t *testing.T) {
	fileBytes := []byte("hello-file")
	reader, size, contentType, reqErr := buildMultipartBody([]bodyField{
		{Key: "note", Value: "你好"},
		{
			Key:         "avatar",
			Kind:        "file",
			FileName:    "note.txt",
			ContentType: "text/plain",
			DataBase64:  base64.StdEncoding.EncodeToString(fileBytes),
		},
		{Key: "skipped", Value: "no", Enabled: boolPtr(false)},
		{Key: "", Value: "ignored"},
	})
	if reqErr != nil {
		t.Fatalf("build multipart: %s", reqErr.Message)
	}
	if size <= 0 {
		t.Fatal("expected a non-empty multipart body")
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatalf("content type %q: %v", contentType, err)
	}
	if mediaType != "multipart/form-data" || params["boundary"] == "" {
		t.Fatalf("content type = %q", contentType)
	}

	form, err := multipart.NewReader(reader, params["boundary"]).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	if got := form.Value["note"]; len(got) != 1 || got[0] != "你好" {
		t.Fatalf("text field = %#v", form.Value)
	}
	if _, ok := form.Value["skipped"]; ok {
		t.Fatal("disabled field was included")
	}
	files := form.File["avatar"]
	if len(files) != 1 {
		t.Fatalf("file parts = %d", len(files))
	}
	header := files[0]
	if header.Filename != "note.txt" {
		t.Fatalf("filename = %q", header.Filename)
	}
	if got := header.Header.Get("Content-Type"); got != "text/plain" {
		t.Fatalf("part content type = %q", got)
	}
	opened, err := header.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	got, err := io.ReadAll(opened)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, fileBytes) {
		t.Fatalf("file bytes = %q", got)
	}
}

func TestBuildMultipartRejectsUnsafeContentType(t *testing.T) {
	payload := []byte("hello-file")
	reader, _, contentType, reqErr := buildMultipartBody([]bodyField{{
		Key:         "blob",
		Kind:        "file",
		FileName:    "a.bin",
		ContentType: "text/plain\r\nX-Injected: yes",
		DataBase64:  base64.StdEncoding.EncodeToString(payload),
	}})
	if reqErr != nil {
		t.Fatalf("build multipart: %s", reqErr.Message)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	part, err := multipart.NewReader(reader, params["boundary"]).NextPart()
	if err != nil {
		t.Fatal(err)
	}
	got := part.Header.Get("Content-Type")
	if strings.Contains(got, "X-Injected") || strings.Contains(got, "\n") {
		t.Fatalf("unsafe content type leaked: %q", got)
	}
	if !strings.HasPrefix(got, "text/plain") {
		t.Fatalf("expected detected text type, got %q", got)
	}
}

func boolPtr(value bool) *bool { return &value }
