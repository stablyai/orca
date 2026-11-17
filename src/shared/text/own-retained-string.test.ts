import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownRetainedString, resetOwnRetainedStringCopier } from './own-retained-string'
import { copyUtf16SuffixToOwnedString } from './owned-utf16-suffix'

const PARENT_CHARS = 1024 * 1024
const PARENTS = 32
const TAIL_CHARS = 4096

function collectHeap(): number {
  const gc = globalThis.gc
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

  it('matches the block copier when Buffer is unavailable', () => {
    const values = [
      '漢\ud800|\udc00|\ud83d'.repeat(512),
      `\x1b]9999;${'x'.repeat(4096)}\ude00`,
      '😀'.repeat(2048)
    ]
    const withBuffer = values.map((value) => ownRetainedString(value))

    resetOwnRetainedStringCopier()
    // Renderer and mobile bundles have no Buffer; the fallback must be byte-identical.
    vi.stubGlobal('Buffer', undefined)
    try {
      const owned = retainedBytes((parent) =>
        ownRetainedString(parent.slice(parent.length - TAIL_CHARS))
      )
      expect(owned).toBeLessThan(4 * 1024 * 1024)
      values.forEach((value, index) => {
        expect(ownRetainedString(value)).toBe(value)
        expect(ownRetainedString(value)).toBe(withBuffer[index])
        expect(ownRetainedString(value)).toBe(copyUtf16SuffixToOwnedString(value, value.length))
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
