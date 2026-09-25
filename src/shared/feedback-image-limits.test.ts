import { describe, expect, it } from 'vitest'
import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES
} from './feedback-image-limits'

// Why: the exact value is a judgement call, staying under the host's limit is
// not. https://www.onorca.dev/v1/feedback is a Vercel Function and rejects
// request bodies over 4.5 MB with 413 FUNCTION_PAYLOAD_TOO_LARGE (orca#22466),
// so a budget at or above that ships the original bug back.
const VERCEL_FUNCTION_PAYLOAD_LIMIT_BYTES = 4_500_000

describe('feedback image limits', () => {
  it('keeps the whole attachment budget under the endpoint host request-body limit', () => {
    expect(MAX_FEEDBACK_IMAGE_TOTAL_BYTES).toBeLessThan(VERCEL_FUNCTION_PAYLOAD_LIMIT_BYTES)
  })

  it('cannot let one image exceed the whole budget', () => {
    expect(MAX_FEEDBACK_IMAGE_BYTES).toBeLessThanOrEqual(MAX_FEEDBACK_IMAGE_TOTAL_BYTES)
  })

  it('leaves room for more than one attachment', () => {
    expect(MAX_FEEDBACK_IMAGE_COUNT).toBeGreaterThan(1)
  })
})
