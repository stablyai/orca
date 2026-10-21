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
})
