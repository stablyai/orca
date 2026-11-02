import { describe, expect, it } from 'vitest'
import { MAX_FEEDBACK_IMAGE_BYTES, MAX_FEEDBACK_IMAGE_TOTAL_BYTES } from './feedback-image-limits'

// Vercel rejects feedback bodies above 4.5 MB with 413 FUNCTION_PAYLOAD_TOO_LARGE (#22466); keep the budget below it.
const VERCEL_FUNCTION_PAYLOAD_LIMIT_BYTES = 4_500_000

describe('feedback image limits', () => {
  it('keeps the whole attachment budget under the endpoint host request-body limit', () => {
    expect(MAX_FEEDBACK_IMAGE_TOTAL_BYTES).toBeLessThan(VERCEL_FUNCTION_PAYLOAD_LIMIT_BYTES)
  })

  it('cannot let one image exceed the whole budget', () => {
    expect(MAX_FEEDBACK_IMAGE_BYTES).toBeLessThanOrEqual(MAX_FEEDBACK_IMAGE_TOTAL_BYTES)
  })
})
