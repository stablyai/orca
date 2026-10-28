// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type * as NativeChatWorkRunModule from '../../../../shared/native-chat/native-chat-work-run'
import type * as NativeChatProseModule from '../../../../shared/native-chat/transcript/native-chat-prose'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type * as UnifiedPatchModule from '../../../../shared/native-chat/tools/native-chat-unified-patch'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

// Count markdown derivations: low render counts alone can hide repeated settled-row work.
const proseCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../shared/native-chat/transcript/native-chat-prose', async (importOriginal) => {
  const actual = await importOriginal<typeof NativeChatProseModule>()
  return {
    ...actual,
    nativeChatProseToMarkdown: (prose: Parameters<typeof actual.nativeChatProseToMarkdown>[0]) => {
      proseCalls.count += 1
      return actual.nativeChatProseToMarkdown(prose)
    }
  }
})

const patchCalls = vi.hoisted(() => ({ detailed: 0, summary: 0 }))
vi.mock(
  '../../../../shared/native-chat/tools/native-chat-unified-patch',
  async (importOriginal) => {
    const actual = await importOriginal<typeof UnifiedPatchModule>()
    return {
      ...actual,
      editLinesFromUnifiedPatch: (...args: Parameters<typeof actual.editLinesFromUnifiedPatch>) => {
        patchCalls.detailed += 1
        return actual.editLinesFromUnifiedPatch(...args)
      },
      summarizeUnifiedPatch: (...args: Parameters<typeof actual.summarizeUnifiedPatch>) => {
        patchCalls.summary += 1
        return actual.summarizeUnifiedPatch(...args)
      }
    }
  }
)

// Count work-run derivations because rebuilt member arrays can defeat row memoization.
const entriesCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../shared/native-chat/native-chat-work-run', async (importOriginal) => {
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
beforeEach(() => {
  proseCalls.count = 0
  patchCalls.detailed = 0
  patchCalls.summary = 0
  entriesCalls.count = 0
})

const TRANSCRIPT_LENGTH = 120

function settledMessages(): NativeChatMessage[] {
  return Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    blocks: [{ type: 'text' as const, text: `settled line ${index}` }],
    timestamp: index + 1,
    source: 'transcript' as const
  }))
}

function sessionWith(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

describe('native chat transcript re-render cost during a streaming turn', () => {
  it('rebuilds only the rows whose blocks changed, not the whole transcript per frame', () => {
    const messages = settledMessages()
    const { rerender } = render(
      <NativeChatMessageList
        session={sessionWith(messages)}
        isWorking={true}
        expandSignal={false}
      />
    )

    const afterFirstPaint = proseCalls.count
    expect(afterFirstPaint).toBeGreaterThanOrEqual(TRANSCRIPT_LENGTH)

    // A streaming turn publishes a frame per SDK event; only the tail message's blocks change.
    const STREAM_FRAMES = 20
    for (let frame = 1; frame <= STREAM_FRAMES; frame += 1) {
      const streaming = messages.slice(0, -1).concat({
        ...messages.at(-1)!,
        blocks: [{ type: 'text' as const, text: `streaming token ${frame}` }]
      })
      rerender(
        <NativeChatMessageList
          session={sessionWith(streaming)}
          isWorking={true}
          expandSignal={false}
        />
      )
    }

    const perFrame = (proseCalls.count - afterFirstPaint) / STREAM_FRAMES
    // Stable settled blocks should leave only the streaming tail rebuilding markdown.
    expect(perFrame).toBeLessThan(TRANSCRIPT_LENGTH / 10)
  })

  it('keeps structured diff rows lazy and reuses counts across journal updates', () => {
    patchCalls.detailed = 0
    patchCalls.summary = 0
    const user: AgentJournalRenderItem = {
      itemId: 'user',
      revision: 1,
      sequence: 1,
      observedAt: 1000,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Edit a file' }] }
    }
    const diff: AgentJournalRenderItem = {
      itemId: 'diff',
      revision: 1,
      sequence: 2,
      observedAt: 2000,
      body: {
        kind: 'diff',
        path: 'src/a.ts',
        patch: {
          head: '@@ -1 +1 @@\n-old\n+new',
          truncated: false,
          digest: 'fixture',
          byteLength: 25
        }
      }
    }
    const view = (items: AgentJournalRenderItem[]) => (
      <NativeChatMessageList
        session={sessionWith(projectStructuredAgentSessionMessages(items, [], []))}
        journalItems={items}
        isWorking={false}
        expandSignal={false}
      />
    )
    const { rerender } = render(view([user, diff]))
    expect(patchCalls).toEqual({ summary: 1, detailed: 0 })
    for (let frame = 0; frame < 20; frame += 1) {
      rerender(
        view([
          user,
          diff,
          {
            itemId: 'tail',
            revision: frame + 1,
            sequence: 3,
            observedAt: 3000,
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: `Token ${frame}` }]
            }
          }
        ])
      )
    }
    expect(patchCalls).toEqual({ summary: 1, detailed: 0 })
    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    expect(patchCalls.detailed).toBe(0)
    expect(screen.queryByText('Totals from recorded edits in this turn.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show diff' }))
    expect(patchCalls).toEqual({ summary: 1, detailed: 1 })
    expect(screen.getByText('new')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hide diff' }))
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    expect(patchCalls).toEqual({ summary: 1, detailed: 1 })
    expect(screen.getByText('new')).toBeInTheDocument()
  })
})

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
