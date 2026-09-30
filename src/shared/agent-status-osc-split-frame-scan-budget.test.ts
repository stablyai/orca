import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'

/** Total characters swept by terminator/prefix searches across every chunk of a feed. */
function feedWithScanBudget(chunks: string[]) {
  let searchedChars = 0
  const indexOf = String.prototype.indexOf
  const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search,
    from = 0
  ) {
    const found = indexOf.call(this, search, from)
    searchedChars += (found === -1 ? this.length : found + String(search).length) - Number(from)
    return found
  })
  try {
    const process = createAgentStatusOscProcessor()
    const results = chunks.map((chunk) => process(chunk))
    return { results, searchedChars }
  } finally {
    spy.mockRestore()
  }
}

describe('OSC 9999 split-frame scan budget', () => {
  it('keeps per-chunk work flat as the split frame accumulates', () => {
    // One unterminated marker whose payload arrives one character at a time.
    const feedOf = (chunkCount: number): string[] => [
      '\x1b]9999;{"state":"working","prompt":"',
      ...Array<string>(chunkCount).fill('x')
    ]

    const small = feedWithScanBudget(feedOf(2000))
    const large = feedWithScanBudget(feedOf(4000))

    expect(small.results.every((result) => result.payloads.length === 0)).toBe(true)
    // Re-scanning the accumulation would quadruple the budget when the feed doubles.
    expect(large.searchedChars).toBeLessThan(small.searchedChars * 3)
  })

  it.each(['\x07', '\x1b\\'])(
    'matches whole-string parsing when split at every offset with terminator %j',
    (terminator) => {
      const stream = `head\x1b]9999;{"state":"working","prompt":"p"}${terminator}tail`
      const whole = createAgentStatusOscProcessor()(stream)

      for (let split = 1; split < stream.length; split += 1) {
        const process = createAgentStatusOscProcessor()
        const first = process(stream.slice(0, split))
        const second = process(stream.slice(split))
        expect({
          cleanData: first.cleanData + second.cleanData,
          payloads: [...first.payloads, ...second.payloads]
        }).toEqual({ cleanData: whole.cleanData, payloads: whole.payloads })
      }
    }
  )

  it('finds a string terminator straddling the resume boundary', () => {
    const process = createAgentStatusOscProcessor()
    // The ESC lands as the last character of the carried frame; the backslash arrives next.
    expect(process('\x1b]9999;{"state":"working"}\x1b').payloads).toEqual([])
    expect(process('\\rest').payloads).toMatchObject([{ state: 'working' }])
  })

  it('still parses a payload that completes many chunks later', () => {
    const process = createAgentStatusOscProcessor()
    process('\x1b]9999;{"state":"wor')
    for (const chunk of ['k', 'i', 'n', 'g']) {
      expect(process(chunk).payloads).toEqual([])
    }
    expect(process('"}\x07done').payloads).toMatchObject([{ state: 'working' }])
  })
})
