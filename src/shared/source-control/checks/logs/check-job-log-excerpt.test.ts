import { afterEach, describe, expect, it, vi } from 'vitest'
import { sanitizeCheckJobLogExcerpt } from './check-job-log-excerpt'
import * as ownership from '../../../own-retained-string'

describe('bounded owned check log sanitation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    ownership.resetOwnRetainedStringCopier()
  })
  it('normalizes separators and unsafe controls while preserving layout', () => {
    const raw = '  α\t\x1b[31merror:\x1b[0m\r\n界\r😀\n\x00\x01\x08\x0b\x0c\x1f\x7f\x85\x9c\n'
    expect(sanitizeCheckJobLogExcerpt(raw)).toBe('  α\terror:\n界\n😀\n\n')
  })
  it('preserves emoji and word joiners while removing other format controls', () => {
    const raw = '\ufeff👨\u200d👩\u200d👧\u200d👦 می\u200cروم \u202eerror\u202c\u200b\n'
    expect(sanitizeCheckJobLogExcerpt(raw)).toBe('👨\u200d👩\u200d👧\u200d👦 می\u200cروم error\n')
  })
})
