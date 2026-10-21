import { describe, expect, it, vi } from 'vitest'
import * as ownership from './own-retained-string'
import { extractOscTitleScanTail } from './osc-title-scan-tail'

const INCOMPLETE_TITLE = '\x1b]2;Working on a terminal title'

describe('OSC title scan tail storage', () => {
  it('routes every retained title tail through ownRetainedString', () => {
    const own = vi.spyOn(ownership, 'ownRetainedString')
    try {
      const tail = extractOscTitleScanTail('x'.repeat(32 * 1024) + INCOMPLETE_TITLE)
      expect(own).toHaveBeenCalledTimes(1)
      expect(own).toHaveBeenLastCalledWith(INCOMPLETE_TITLE)
      expect(tail).toBe(INCOMPLETE_TITLE)

      // Ownership is unconditional: a growing title is re-owned on every chunk.
      let pending = tail
      for (let index = 0; index < 8; index += 1) {
        pending = extractOscTitleScanTail(pending + 'x'.repeat(512))
      }
      expect(own).toHaveBeenCalledTimes(9)
      expect(own).toHaveBeenLastCalledWith(pending)

      // An unrelated incomplete OSC still yields nothing to retain.
      expect(extractOscTitleScanTail(`${'x'.repeat(32 * 1024)}\x1b]9999;incomplete`)).toBe('')
    } finally {
      own.mockRestore()
    }
  })

  it.each([
    [16 * 1024, 256, INCOMPLETE_TITLE],
    [64 * 1024, 64, INCOMPLETE_TITLE],
    [1024 * 1024, 16, INCOMPLETE_TITLE],
    [16 * 1024, 128, INCOMPLETE_TITLE + 'x'.repeat(16 * 1024)]
  ])('keeps %i-character chunks with %i incomplete titles byte-exact', (size, count, title) => {
    const tails: string[] = []
    for (let index = 0; index < count; index++) {
      tails.push(
        extractOscTitleScanTail(String.fromCharCode(65 + (index % 26)).repeat(size) + title)
      )
    }
    const expected = title.length <= 4096 ? title : title.slice(0, 4) + title.slice(-4092)
    expect(tails).toEqual(Array.from({ length: count }, () => expected))
  })

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
