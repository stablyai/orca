// Why: the catalog keeps known secret fields out of backups, but free-form values (custom commands,
// quick commands, args) can still hold a pasted token. Anything that looks like one is dropped, not
// masked, so a backup file never carries even a partial credential.
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // Credentials embedded in a URL, e.g. https://user:pass@host
  /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
]

const SECRET_NAME_PATTERN = /(?:api[-_]?key|secret|password|passwd|token|cookie|credential)/i

const MAX_SCAN_DEPTH = 32

export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
}

/** True when a value, or any string nested inside it, looks like a credential. */
export function containsSecretLikeValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCAN_DEPTH) {
    return true
  }
  if (typeof value === 'string') {
    return looksLikeSecretValue(value)
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretLikeValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([name, nested]) =>
        (SECRET_NAME_PATTERN.test(name) && typeof nested === 'string' && nested.length > 0) ||
        containsSecretLikeValue(nested, depth + 1)
    )
  }
  return false
}
