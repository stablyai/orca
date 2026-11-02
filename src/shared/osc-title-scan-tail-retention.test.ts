import { describe, expect, it } from 'vitest'
import { extractOscTitleScanTail } from './osc-title-scan-tail'

describe('OSC title scan tail storage', () => {
  it.each(['0', '1', '2'])('preserves title %s introducer and exact UTF-16 at the cap', (code) => {
    const prefix = `\x1b]${code};`
    for (const length of [4095, 4096, 4097, 16 * 1024]) {
      const value = `${prefix}${'x'.repeat(length - 9)}漢\ud800|\udc00\ud83d`
      const expected = value.length <= 4096 ? value : prefix + value.slice(-4092)
      const tail = extractOscTitleScanTail('a'.repeat(32 * 1024) + value)
      expect(tail).toBe(expected)
      expect(extractOscTitleScanTail(`${tail}\ude00\x1b\\`)).toBe('')
    }
  })

  it('keeps trimming an owned title that grows past the cap', () => {
    let pending = '\x1b]2;'
    for (let index = 0; index < 128; index++) {
      pending = extractOscTitleScanTail(pending + 'x'.repeat(512))
    }
    expect(pending).toBe(`\x1b]2;${'x'.repeat(4092)}`)
  })
})
