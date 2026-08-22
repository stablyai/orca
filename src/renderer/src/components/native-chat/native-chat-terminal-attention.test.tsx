// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  detectNativeChatTerminalAttention,
  useNativeChatTerminalAttention
} from './native-chat-terminal-attention'

const CODEX_HOOK_REVIEW_PROMPT = [
  '\u001b[33mHooks need review\u001b[0m',
  '2 hooks are new or changed.',
  '1. Review hooks',
  '2. Trust all and continue',
  "3. Continue without trusting (hooks won't run)",
  'Press enter to confirm or esc to go back'
].join('\r\n')

describe('native chat terminal attention', () => {
  afterEach(() => vi.useRealTimers())

  it('recognizes the Codex hook-review prompt across ANSI and line breaks', () => {
    expect(detectNativeChatTerminalAttention(CODEX_HOOK_REVIEW_PROMPT, 'codex')).toBe(
      'codex-hooks-review'
    )
  })

  it('does not classify ordinary output or another agent as a Codex blocker', () => {
    expect(detectNativeChatTerminalAttention('Review hooks before release.', 'codex')).toBeNull()
    expect(detectNativeChatTerminalAttention(CODEX_HOOK_REVIEW_PROMPT, 'claude')).toBeNull()
  })

  it('clears the blocker after the terminal prompt is resolved', () => {
    vi.useFakeTimers()
    let screen = CODEX_HOOK_REVIEW_PROMPT
    const readTerminalScreen = (): string => screen
    const { result } = renderHook(() =>
      useNativeChatTerminalAttention({
        agent: 'codex',
        isVisible: true,
        readTerminalScreen
      })
    )

    expect(result.current).toBe('codex-hooks-review')
    screen = 'Codex is ready'
    act(() => vi.advanceTimersByTime(500))
    expect(result.current).toBeNull()
  })
})
