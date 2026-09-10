// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NativeChatProseModule from './native-chat-prose'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type * as UnifiedPatchModule from '../../../../shared/native-chat-unified-patch'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

// Counting real per-row work rather than a render counter: a future refactor could keep the
// render count low while still re-deriving every row's markdown.
const proseCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./native-chat-prose', async (importOriginal) => {
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
vi.mock('../../../../shared/native-chat-unified-patch', async (importOriginal) => {
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
})

const { NativeChatMessageList } = await import('./NativeChatMessageList')

afterEach(cleanup)

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
        fontScale={1}
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
          fontScale={1}
        />
      )
    }

    const perFrame = (proseCalls.count - afterFirstPaint) / STREAM_FRAMES
    // Without row memoization every settled row rebuilt its markdown on every frame. Settled
    // rows keep their block identity, so only the streaming tail should rebuild.
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
        fontScale={1}
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
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    expect(patchCalls).toEqual({ summary: 1, detailed: 1 })
    expect(screen.getByText('new')).toBeInTheDocument()
  })
})
