// Match exact Chromium certificate codes so unrelated failures cannot get certificate recovery advice.
const CHROMIUM_CERTIFICATE_ERROR_CODES = new Set([
  -200, -201, -202, -203, -204, -205, -206, -207, -208, -210, -211, -212, -213, -214, -217, -219
])

export function isChromiumCertificateErrorCode(code: number): boolean {
  return CHROMIUM_CERTIFICATE_ERROR_CODES.has(code)
}

// Share normalization between main certificate handling and renderer overlays so challenge matching agrees.
export function normalizeCertificateError(error: string): string {
  return error
    .trim()
    .replace(/^net::/i, '')
    .toUpperCase()
}
