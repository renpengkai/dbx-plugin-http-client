import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, "../ui/download-name.js"), "utf8"), sandbox);
const suggest = sandbox.HC.downloadName.suggest;

const cases = [
  ["filename quoted pdf", { disposition: 'attachment; filename="report.pdf"', contentType: "application/pdf", url: "https://cdn.example.com/download" }, "report.pdf"],
  ["filename unquoted", { disposition: "attachment; filename=report.pdf", contentType: "application/pdf" }, "report.pdf"],
  ["filename star preferred", { disposition: "attachment; filename=\"fallback.xlsx\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E8%A1%A8.xlsx", contentType: "application/octet-stream", url: "https://example.com/export" }, "季度报表.xlsx"],
  ["rfc5987 language", { disposition: "inline; filename*=utf-8'en'%E6%8A%A5%E5%91%8A.pdf", contentType: "application/pdf" }, "报告.pdf"],
  ["filename star quoted", { disposition: "attachment; filename*=\"UTF-8''file%20name.zip\"", contentType: "application/zip" }, "file name.zip"],
  ["disposition without extension", { disposition: 'attachment; filename="quarterly"', contentType: "application/pdf" }, "quarterly.pdf"],
  ["disposition bin kept", { disposition: 'attachment; filename="payload.bin"', contentType: "application/pdf" }, "payload.bin"],
  ["url pdf", { contentType: "application/pdf", url: "https://cdn.example.com/files/report.pdf?token=1" }, "report.pdf"],
  ["url jpeg", { contentType: "image/jpeg", url: "https://cdn.example.com/files/photo" }, "photo.jpg"],
  ["url png case", { contentType: "image/png", url: "https://cdn.example.com/a/b/photo.PNG" }, "photo.PNG"],
  ["url csv", { contentType: "text/csv; charset=utf-8", url: "https://example.com/export/data" }, "data.csv"],
  ["url json", { contentType: "application/json; charset=utf-8", url: "https://api.example.com/v1/users" }, "users.json"],
  ["octet-stream keeps zip", { contentType: "application/octet-stream", url: "https://example.com/dl/archive.zip" }, "archive.zip"],
  ["generic bin replaced", { contentType: "application/zip", url: "https://example.com/dl/archive.bin" }, "archive.zip"],
  ["xlsx mime", { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url: "https://example.com/dl/sheet" }, "sheet.xlsx"],
  ["trailing slash", { contentType: "application/pdf", url: "https://example.com/download/" }, "download.pdf"],
  ["fallback bin", { contentType: "application/octet-stream", url: "https://example.com/" }, "download.bin"],
  ["mime only", { contentType: "application/pdf", url: "https://example.com/" }, "download.pdf"],
  ["html", { contentType: "text/html; charset=utf-8", url: "https://example.com/docs/page" }, "page.html"],
  ["path traversal", { disposition: 'attachment; filename="../../etc/passwd"', contentType: "text/plain" }, "passwd.txt"],
  ["quote stripped", { disposition: 'attachment; filename="a\\"b.csv"', contentType: "text/csv" }, "ab.csv"],
  ["headers fallback", { headers: [{ key: "Content-Disposition", value: 'attachment; filename="report.pdf"' }, { key: "Content-Type", value: "application/pdf" }], url: "https://example.com/x" }, "report.pdf"]
];

let failed = 0;
cases.forEach(([name, input, want]) => {
  const got = suggest(input);
  if (got !== want) {
    failed += 1;
    console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  } else {
    console.log(`PASS ${name}`);
  }
});
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log(`${cases.length} download-name checks passed`);
