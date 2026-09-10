import { afterEach, describe, expect, it } from 'vitest'
import { ownRetainedString, resetOwnRetainedStringCopier } from './own-retained-string'
import { copyUtf16SuffixToOwnedString } from './owned-utf16-suffix'

const PARENT_CHARS = 1024 * 1024
const PARENTS = 32
const TAIL_CHARS = 4096

function collectHeap(): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) {
    throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
  }
  void /reset/.test('reset')
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

function retainedBytes(take: (parent: string) => string): number {
  const kept: string[] = []
  for (let index = 0; index < 8; index += 1) {
    take('warmup'.repeat(PARENT_CHARS / 6))
  }
  const before = collectHeap()
  for (let index = 0; index < PARENTS; index += 1) {
    kept.push(take(String.fromCharCode(65 + (index % 26)).repeat(PARENT_CHARS)))
  }
  const used = collectHeap() - before
  expect(kept).toHaveLength(PARENTS)
  expect(kept[0]).toHaveLength(TAIL_CHARS)
  return used
}

describe('ownRetainedString', () => {
  afterEach(() => {
    resetOwnRetainedStringCopier()
  })

  it('releases the parent chunk that a retained tail was sliced from', () => {
    const sliced = retainedBytes((parent) => parent.slice(parent.length - TAIL_CHARS))
    const owned = retainedBytes((parent) =>
      ownRetainedString(parent.slice(parent.length - TAIL_CHARS))
    )

    // 32 x 1 Mi parents pinned by 32 x 4 Ki tails, versus the tails alone.
    expect(sliced).toBeGreaterThan(16 * 1024 * 1024)
    expect(owned).toBeLessThan(4 * 1024 * 1024)
    expect(owned).toBeLessThan(sliced / 8)
  })

  it.each([
    ['ascii', 'x'.repeat(4096)],
    ['two-byte', '漢'.repeat(4096)],
    ['lone lead surrogate', `\ud800${'a'.repeat(64)}`],
    ['lone trail surrogate', `${'a'.repeat(64)}\udfff`],
    ['split pair around padding', `\ud83d${'a'.repeat(64)}\ude00`],
    ['well-formed astral', '😀'.repeat(2048)],
    ['mixed controls', `\x1b]2;${'漢\ud800|\udc00\ud83d'.repeat(512)}`]
  ])('round-trips %s exactly', (_label, value) => {
    expect(ownRetainedString(value)).toBe(value)
    expect(ownRetainedString(value).length).toBe(value.length)
  })

  it('leaves already-flat short strings alone', () => {
    // Below V8 SlicedString::kMinLength a slice is already a standalone copy.
    for (const value of ['', '\x1b', '\ud800', 'x'.repeat(12)]) {
      const parent = `${'y'.repeat(64 * 1024)}${value}`
      const short = parent.slice(parent.length - value.length)
      expect(ownRetainedString(short)).toBe(short)
    }
    expect(ownRetainedString('x'.repeat(13))).toBe('x'.repeat(13))
  })

  it('matches the block copier when Buffer is unavailable', () => {
    const original = (globalThis as { Buffer?: unknown }).Buffer
    const values = [
      '漢\ud800|\udc00|\ud83d'.repeat(512),
      `\x1b]9999;${'x'.repeat(4096)}\ude00`,
      '😀'.repeat(2048)
    ]
    const withBuffer = values.map((value) => ownRetainedString(value))

    resetOwnRetainedStringCopier()
    // Renderer and mobile bundles have no Buffer; the fallback must be byte-identical.
    delete (globalThis as { Buffer?: unknown }).Buffer
    try {
      values.forEach((value, index) => {
        expect(ownRetainedString(value)).toBe(value)
        expect(ownRetainedString(value)).toBe(withBuffer[index])
        expect(ownRetainedString(value)).toBe(copyUtf16SuffixToOwnedString(value, value.length))
      })
    } finally {
      ;(globalThis as { Buffer?: unknown }).Buffer = original
    }
  })
})
