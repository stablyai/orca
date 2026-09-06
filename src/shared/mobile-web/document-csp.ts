export function mobileWebDocumentCspDirectives(markdownEditorScriptHash: string) {
  return [
    "default-src 'none'",
    `script-src 'self' ${markdownEditorScriptHash}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'self' data:",
    "child-src 'self' data:",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ] as const
}

export function mobileWebDocumentCsp(markdownEditorScriptHash: string): string {
  return mobileWebDocumentCspDirectives(markdownEditorScriptHash).join('; ')
}
