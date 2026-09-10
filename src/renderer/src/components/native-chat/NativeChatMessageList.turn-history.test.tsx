// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

const scrollTo = vi.fn()
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
function item(
  itemId: string,
  body: AgentJournalItemBody,
  sequence: number
): AgentJournalRenderItem {
  return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1 }
}
const user = item(
  'user',
  { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Make the change' }] },
  1
)
const prose = item(
  'prose',
  { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Updating the files.' }] },
  2
)
function diff(patch = '@@ -1 +1 @@\n-before\n+after'): AgentJournalRenderItem {
  return item(
    'diff',
    {
      kind: 'diff',
      path: 'src/a.ts',
      patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
    },
    3
  )
}
function session(items: AgentJournalRenderItem[]): NativeChatLiveSession {
  return {
    messages: projectStructuredItemsToNativeChat(items),
    status: 'ready',
    sessionId: 'session',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}
function view(items: AgentJournalRenderItem[], structured = true) {
  return (
    <NativeChatMessageList
      session={session(items)}
      journalItems={structured ? items : undefined}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

describe('turn history presentation', () => {
  it('reveals and scrolls to a folded diff card from a collapsed completed turn', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    render(view([user, prose, diff()]))
    expect(screen.queryByText('Edited file')).toBeNull()
    const header = screen.getByRole('button', { name: /1 changed file/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    expect(screen.getByText('Edited file')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /1× Diff/ }))
    expect(screen.queryByText('Edited file')).toBeNull()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('updates journal revisions and replaces flat approval text with a passive receipt', () => {
    const approval = item(
      'approval',
      {
        kind: 'approval',
        title: 'Run tests?',
        detail: 'pnpm test',
        options: [{ id: 'allow', label: 'Allow once' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      4
    )
    const initial = [user, prose, diff(), approval]
    const { rerender } = render(view(initial))
    expect(screen.queryByText('Run tests?')).toBeNull()
    if (approval.body.kind !== 'approval') {
      throw new Error('fixture')
    }
    const resolved = {
      ...approval,
      revision: 2,
      body: {
        ...approval.body,
        resolution: {
          state: 'resolved' as const,
          selectedOptionId: 'allow',
          resolvedBy: 'desktop',
          resolvedAt: 5000
        }
      }
    }
    rerender(view([user, prose, diff('@@ -0,0 +1,2 @@\n+first\n+second'), resolved]))
    expect(screen.getByRole('button', { name: /1 changed file \+2/ })).toBeInTheDocument()
    expect(screen.getByText('Run tests?')).toBeInTheDocument()
    expect(screen.getByText('Allow once')).toBeInTheDocument()
    expect(screen.getByText('Answered on desktop')).toBeInTheDocument()
    expect(screen.getByText('Resolved').closest('[data-native-chat-receipt]')).not.toBeNull()
    expect(screen.queryByText('resolved')).toBeNull()
  })

  it('keeps rollups turn-local and leaves legacy message lists unchanged', () => {
    const secondUser = item(
      'user-two',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Again' }] },
      5
    )
    const secondDiff = { ...diff(), itemId: 'second-diff', sequence: 6, observedAt: 6000 }
    const items = [user, prose, diff(), secondUser, secondDiff]
    const { rerender } = render(view(items))
    expect(screen.getAllByRole('button', { name: /1 changed file/ })).toHaveLength(2)
    rerender(view(items, false))
    expect(screen.queryByRole('button', { name: /changed file/ })).toBeNull()
  })
})
