import { describe, expect, it, vi } from 'vitest'
import { parseAnsiSegments } from './ipynb-ansi'

describe('parseAnsiSegments', () => {
  it('does not scan plain accumulated output for SGR or stripping patterns', () => {
    const text = 'iteration α🐋\tvalue\n'.repeat(100_000)
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const replace = vi.spyOn(String.prototype, 'replace')
    let segments: ReturnType<typeof parseAnsiSegments>
    let scans: number
    try {
      segments = parseAnsiSegments(text)
      scans = matchAll.mock.calls.length + replace.mock.calls.length
    } finally {
      matchAll.mockRestore()
      replace.mockRestore()
    }
    expect(segments).toEqual([{ text }])
    expect(scans).toBe(0)
    expect(parseAnsiSegments('')).toEqual([])
  })
})
