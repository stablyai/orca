import { expect, it, vi } from 'vitest'
import { createRecordedLeafReader } from './workspace-layout-recorded-key-order'
import { emptySession } from './workspace-layout-session.test-fixture'

it('charges actual full-key acquisition, bounded sort/query characters and suffix output at N/10N', () => {
  for (const n of [10, 100]) {
    const session = emptySession()
    const sourceKeys = Array.from(
      { length: n },
      (_, i) => `tab-${String(n - i).padStart(3, '0')}:leaf`
    )
    session.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      sourceKeys.map((key) => [key, 'inc'])
    )
    const count = {
      keyOccurrences: 0,
      keyCharacters: 0,
      characterReads: 0,
      prefixCharacters: 0,
      sliced: 0
    }
    const keys = Object.keys,
      charCodeAt = String.prototype.charCodeAt,
      startsWith = String.prototype.startsWith,
      slice = String.prototype.slice
    const ks = vi.spyOn(Object, 'keys').mockImplementation((value) => {
      const result = keys(value)
      count.keyOccurrences += result.length
      count.keyCharacters += result.reduce((sum, key) => sum + key.length, 0)
      return result
    })
    const cs = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
      this: string,
      index
    ) {
      count.characterReads++
      return charCodeAt.call(this, index)
    })
    const ps = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
      this: string,
      prefix,
      position
    ) {
      count.prefixCharacters += prefix.length
      return startsWith.call(this, prefix, position)
    })
    const ss = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start,
      end
    ) {
      const result = slice.call(this, start, end)
      count.sliced += result.length
      return result
    })
    const results: (string | undefined)[] = []
    try {
      const reader = createRecordedLeafReader(session)
      for (let i = 1; i <= n; i++) {
        results.push(reader(`tab-${String(i).padStart(3, '0')}`))
      }
    } finally {
      for (const spy of [ks, cs, ps, ss]) {
        spy.mockRestore()
      }
    }
    expect(results).toEqual(Array.from({ length: n }, () => 'leaf'))
    expect(count.keyOccurrences).toBe(n)
    expect(count.sliced).toBe(4 * n)
    const levels = Math.ceil(Math.log2(n))
    // Each merge/query comparison reads at most both full keys; include both schedules.
    expect(count.characterReads).toBeLessThanOrEqual(4 * n * 13 * (levels + 1))
    expect(count.prefixCharacters).toBeLessThanOrEqual(2 * n * 8)
  }
  for (const m of [10, 100]) {
    const session = emptySession()
    session.terminalPtyIncarnationsByPaneKey = { [`x${':x'.repeat(m)}`]: 'inc' }
    const slice = vi.spyOn(String.prototype, 'slice')
    let calls: number
    let result: string | undefined
    try {
      result = createRecordedLeafReader(session)('short')
      calls = slice.mock.calls.length
    } finally {
      slice.mockRestore()
    }
    expect(result).toBeUndefined()
    expect(calls).toBe(0)
  }
})
