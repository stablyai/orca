import { describe, expect, it } from 'vitest'
import { extractOscTitleScanTail } from './osc-title-scan-tail'

describe('extractOscTitleScanTail', () => {
  it('does not carry non-title OSC payloads into the title scanner', () => {
    expect(extractOscTitleScanTail('\x1b]133;D;13')).toBe('')
    expect(extractOscTitleScanTail('\x1b]7;file://host/tmp')).toBe('')
    expect(extractOscTitleScanTail('\x1b]133;D;0\x07\x1b')).toBe('\x1b')
  })
})
