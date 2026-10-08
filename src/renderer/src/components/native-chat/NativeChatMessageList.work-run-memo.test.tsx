// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as NativeChatWorkRunModule from '../../../../shared/native-chat-work-run'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

// Counts each run rebuilding its lines and thoughts: a rebuilt transcript hands every run a fresh
// member list, and only the row's memo keeps a settled run from redoing that work every frame.
const entriesCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../shared/native-chat-work-run', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeChatWorkRunModule>()
  return {
    ...actual,
    nativeChatWorkRunEntries: (...args: Parameters<typeof actual.nativeChatWorkRunEntries>) => {
      entriesCalls.count += 1
      return actual.nativeChatWorkRunEntries(...args)
    }
  }
})

const { NativeChatMessageList } = await import('./NativeChatMessageList')

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

let clock = 0
function row(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks'],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  clock += 1
  return { id, role, blocks, timestamp: clock, source: 'transcript', ...extra }
}
const thought = (id: string) =>
  row(id, 'reasoning', [{ type: 'text', text: `thinking ${id}` }], {
    state: 'completed',
    completedAt: clock + 1
  })
const command = (id: string, output: string) =>
  row(id, 'assistant', [
    { type: 'tool-call', name: 'Bash', input: { command: id }, state: 'completed', callId: id },
    { type: 'tool-result', output, callId: id }
  ])

const prompt = row('user-1', 'user', [{ type: 'text', text: 'go' }])
// Three settled runs, each closed by a reply, then the live run.
const settled = [1, 2, 3].flatMap((turn) => [
  thought(`r${turn}a`),
  command(`c${turn}a`, 'ok'),
  thought(`r${turn}b`),
  command(`c${turn}b`, 'ok'),
  row(`reply-${turn}`, 'assistant', [{ type: 'text', text: `Step ${turn} done.` }])
])
const liveHead = [thought('r4'), command('c4', 'ok')]

function journal(rows: readonly NativeChatMessage[]): AgentJournalRenderItem[] {
  return [
    {
      itemId: prompt.id,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: prompt.blocks }
    },
    {
      itemId: 'turn-1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId: prompt.id }
    },
    ...rows.map((message, index) => ({
      itemId: message.id,
      revision: 1,
      sequence: index + 3,
      observedAt: index + 3,
      body: { kind: 'message' as const, role: message.role, blocks: message.blocks }
    }))
  ]
}

function list(tail: NativeChatMessage): React.JSX.Element {
  const rows = [...settled, ...liveHead, tail]
  const session: NativeChatLiveSession = {
    messages: [prompt, ...rows],
    status: 'working',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
  return (
    <NativeChatMessageList
      session={session}
      journalItems={journal(rows)}
      isWorking
      expandSignal={false}
    />
  )
}

describe('settled work runs while the live run streams', () => {
  it('rebuilds only the live run on each frame', () => {
    const tail = (frame: number) => ({ ...command('c5', `line ${frame}`), id: 'c5' })
    const { rerender, container } = render(list(tail(0)))
    expect(container.querySelectorAll('[data-native-chat-tool-run-state]')).toHaveLength(4)
    entriesCalls.count = 0
    for (let frame = 1; frame <= 5; frame += 1) {
      rerender(list(tail(frame)))
    }
    expect(entriesCalls.count).toBe(5)
  })
})
