// Why: use Chromium's exact certificate codes so unrelated network failures
// never receive certificate-specific recovery copy.
const CHROMIUM_CERTIFICATE_ERROR_CODES = new Set([
  -200, -201, -202, -203, -204, -205, -206, -207, -208, -210, -211, -212, -213, -214, -217, -219
])

export function isChromiumCertificateErrorCode(code: number): boolean {
  return CHROMIUM_CERTIFICATE_ERROR_CODES.has(code)
}

// Why: main (certificate-error handler) and the renderer overlay both compare
// Chromium error strings; keep one normalizer so their challenge-matching can
// never silently diverge.
export function normalizeCertificateError(error: string): string {
  return error
    .trim()
    .replace(/^net::/i, '')
    .toUpperCase()
}
