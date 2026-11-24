import { KNOWN_RATE_LIMIT_ERRORS_A } from './rate-limit-user-facing-error-catalog-a'
import { KNOWN_RATE_LIMIT_ERRORS_B } from './rate-limit-user-facing-error-catalog-b'
import type { RateLimitKnownError } from './rate-limit-user-facing-error-types'

export const KNOWN_RATE_LIMIT_ERRORS: RateLimitKnownError[] = [
  ...KNOWN_RATE_LIMIT_ERRORS_A,
  ...KNOWN_RATE_LIMIT_ERRORS_B
]
