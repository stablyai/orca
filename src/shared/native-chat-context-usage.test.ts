import { describe, expect, it } from 'vitest'
import {
  deriveNativeChatContextUsage,
  formatContextTokenCount,
  isNativeChatCompactionBoundary
} from './native-chat-context-usage'
import type { NativeChatMessage, NativeChatTokenUsage } from './native-chat-types'

function assistant(id: string, usage?: NativeChatTokenUsage, model = 'gpt-5.5'): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 100,
    source: 'transcript',
    model,
    provider: 'openai-codex',
    ...(usage ? { usage } : {})
  }
}

function usage(inputTokens: number, cacheRead = 0, cacheWrite = 0): NativeChatTokenUsage {
  return {
    inputTokens,
    cacheCreationInputTokens: cacheWrite,
    cacheReadInputTokens: cacheRead,
    outputTokens: 16
  }
}

const compaction: NativeChatMessage = {
  id: 'compacted',
  role: 'system',
  blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
  timestamp: 150,
  source: 'transcript'
}

const noWindow = (): number | null => null

describe('deriveNativeChatContextUsage', () => {
  it('sums input and both cache counts of the newest response against its window', () => {
    const windows: NativeChatMessage[] = []
    const derived = deriveNativeChatContextUsage(
      [assistant('older', usage(5)), assistant('newest', usage(680, 20_992, 8))],
      (message) => {
        windows.push(message)
        return 272_000
      }
    )
    expect(derived).toEqual({
      usedTokens: 21_680,
      windowTokens: 272_000,
      percentage: 8
    })
    // The window is asked of the response that was measured, not the session's picker.
    expect(windows.map(({ id }) => id)).toEqual(['newest'])
  })

  it('reports the used figure alone when the window is unknown', () => {
    expect(deriveNativeChatContextUsage([assistant('a', usage(450_000))], noWindow)).toEqual({
      usedTokens: 450_000,
      windowTokens: null,
      percentage: null
    })
    expect(
      deriveNativeChatContextUsage([assistant('a', usage(10))], () => 0)?.windowTokens
    ).toBeNull()
  })

  it('skips responses whose accounting does not reflect the prompt', () => {
    const messages = [assistant('measured', usage(100)), assistant('aborted')]
    expect(deriveNativeChatContextUsage(messages, noWindow)?.usedTokens).toBe(100)
  })

  it('knows nothing after a compaction until the next response lands', () => {
    const before = [assistant('before', usage(200_000)), compaction]
    expect(deriveNativeChatContextUsage(before, noWindow)).toBeNull()
    expect(
      deriveNativeChatContextUsage([...before, assistant('after', usage(30_000))], noWindow)
        ?.usedTokens
    ).toBe(30_000)
  })

  it('is null before any response carried usage', () => {
    expect(deriveNativeChatContextUsage([], noWindow)).toBeNull()
    expect(deriveNativeChatContextUsage([assistant('zero', usage(0))], noWindow)).toBeNull()
  })
})

describe('isNativeChatCompactionBoundary', () => {
  it('matches only the compaction presentation', () => {
    expect(isNativeChatCompactionBoundary(compaction)).toBe(true)
    expect(
      isNativeChatCompactionBoundary({
        ...compaction,
        blocks: [{ type: 'text', text: 'Context compacted' }]
      })
    ).toBe(false)
  })
})

describe('formatContextTokenCount', () => {
  it('uses the compact notation agent CLIs print', () => {
    expect(formatContextTokenCount(10)).toBe('10')
    expect(formatContextTokenCount(18_600)).toBe('18.6k')
    expect(formatContextTokenCount(272_000)).toBe('272k')
    expect(formatContextTokenCount(981_400)).toBe('981.4k')
    expect(formatContextTokenCount(1_000_000)).toBe('1m')
    expect(formatContextTokenCount(-5)).toBe('0')
  })
})
