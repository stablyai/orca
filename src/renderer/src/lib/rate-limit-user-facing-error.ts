import { translate } from '@/i18n/i18n'
import { KNOWN_RATE_LIMIT_ERRORS } from './rate-limit-user-facing-error-catalog'

export function formatRateLimitUserFacingError(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return ''
  }
  const message = raw.trim()
  for (const known of KNOWN_RATE_LIMIT_ERRORS) {
    if (typeof known.test === 'string') {
      if (message === known.test) {
        return translate(known.key, known.fallback)
      }
      // Why: macOS Tailscale DNS hint appends after the base English error.
      if (message.startsWith(`${known.test} `)) {
        return `${translate(known.key, known.fallback)}${message.slice(known.test.length)}`
      }
      continue
    }
    const match = message.match(known.test)
    if (match) {
      return translate(known.key, known.fallback, known.vars?.(match))
    }
  }
  return message
}
