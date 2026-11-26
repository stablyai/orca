// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'
import { useNativeChatTurnDiffs } from './use-native-chat-turn-diffs'

const NO_SUBAGENT_ROWS = [] as const

const message = (id: string, text: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

// Perf contract: a live window that only grows a reply's text rebuilds no turn diff totals,
// which visit every loaded message.
it('keeps its totals while only a reply streams, and rebuilds them when the rows change', () => {
  const structure = [message('a', 'Done.'), message('b', 'The reply so far')]
  const turnKeys = ['turn-1', 'turn-2']
  const window = (text: string): NativeChatTurnRows => ({
    messages: [structure[0]!, message('b', text)],
    structureMessages: structure,
    turnKeys,
    liveTurnKey: 'turn-2'
  })
  const { result, rerender } = renderHook(
    ({ turns }) => useNativeChatTurnDiffs(turns, NO_SUBAGENT_ROWS),
    {
      initialProps: { turns: window('The reply so far') }
    }
  )
  const totals = result.current
  for (let step = 0; step < 50; step++) {
    rerender({ turns: window(`The reply so far${' and more'.repeat(step)}`) })
  }
  expect(result.current).toBe(totals)

  const saved = [...structure, message('c', 'A new row')]
  rerender({
    turns: { messages: saved, structureMessages: saved, turnKeys, liveTurnKey: 'turn-2' }
  })
  expect(result.current).not.toBe(totals)
})
