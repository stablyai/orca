// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as workRuns from '../../../../../../shared/native-chat/transcript/folding/native-chat-work-run'
import { noteStreamedTextStage } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatWorkRun, useNativeChatWorkRunStreamed } from './use-native-chat-work-run'

vi.mock('../../../../../../shared/native-chat/transcript/folding/native-chat-work-run', {
  spy: true
})

afterEach(cleanup)

const call = (id: string): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Read', input: { path: id } }],
  timestamp: 1,
  source: 'transcript'
})
const thought = (text: string): NativeChatMessage => ({
  id: 'thought',
  role: 'reasoning',
  state: 'running',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
  source: 'transcript'
})

// Perf contract: a thought streaming in a run leaves the run's calls laid out once, so its
// header and asides hold; only the thought's own text moves.
it('lays a run out once while one of its thoughts streams', () => {
  const entries = vi.mocked(workRuns.nativeChatWorkRunEntries)
  const laidOut = [
    ...Array.from({ length: 200 }, (_, index) => call(`call-${index}`)),
    thought('A')
  ]
  const { result, rerender } = renderHook(
    ({ members }) => ({
      run: useNativeChatWorkRun(members, { revealedDiff: undefined, activeTurnIsWorking: true }),
      streamed: useNativeChatWorkRunStreamed(members)
    }),
    { initialProps: { members: laidOut } }
  )
  const first = result.current.run
  let members = laidOut
  let text = 'A'
  for (let window = 0; window < 20; window++) {
    text += ` step ${window}`
    const next = [...members.slice(0, -1), thought(text)]
    noteStreamedTextStage(next, members)
    members = next
    rerender({ members })
  }
  expect(entries).toHaveBeenCalledTimes(1)
  expect(result.current.run).toBe(first)
  expect(result.current.streamed?.get('thought')?.blocks).toEqual([{ type: 'text', text }])
  // A call joining the run lays it out again.
  rerender({ members: [...members, call('call-new')] })
  expect(entries).toHaveBeenCalledTimes(2)
})
