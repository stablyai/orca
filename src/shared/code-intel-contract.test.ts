import { describe, expect, it } from 'vitest'
import {
  CODE_INTEL_MAX_LOCATIONS,
  CODE_INTEL_MAX_PREVIEW_LEN,
  isOkResult,
  isUnsupportedResult,
  type CodeIntelResult
} from './code-intel-contract'

describe('code-intel-contract', () => {
  it('exposes positive caps', () => {
    expect(CODE_INTEL_MAX_LOCATIONS).toBeGreaterThan(0)
    expect(CODE_INTEL_MAX_PREVIEW_LEN).toBeGreaterThan(0)
  })

  it('discriminates ok from unsupported (empty ok is not unsupported)', () => {
    const empty: CodeIntelResult = {
      status: 'ok',
      bufferVersion: 0,
      locations: [],
      truncated: false
    }
    const unsupported: CodeIntelResult = { status: 'unsupported', reason: 'remote-runtime' }
    expect(isOkResult(empty)).toBe(true)
    expect(isUnsupportedResult(empty)).toBe(false)
    expect(isUnsupportedResult(unsupported)).toBe(true)
    expect(isOkResult(unsupported)).toBe(false)
  })
})
