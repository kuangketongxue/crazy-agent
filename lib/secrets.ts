export function normalizeApiKey(raw?: string | null) {
  const v = String(raw || "").trim();
  if (!v) return "";
  return v
    .replace(/[\r\n\t]/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .trim();
}

