import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'codex-subagent-progress',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    agentStatusByPaneKey: {} as Record<string, unknown>,
    agentStatusEpoch: 0
  },
  liveSession: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/native-chat/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: mocks.liveSession
}))

vi.mock('@/components/native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: ({
    session,
    isWorking
  }: {
    session: { messages: { id: string }[]; hasMore: boolean }
    isWorking: boolean
  }) => (
    <div
      data-testid="message-list"
      data-working={isWorking ? 'true' : 'false'}
      data-message-ids={session.messages.map((message) => message.id).join(',')}
      data-has-more={String(session.hasMore)}
    />
  )
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, modal }: { children: ReactNode; modal?: boolean }) => (
    <div data-modal={String(modal)}>{children}</div>
  ),
  SheetContent: ({ children, showOverlay }: { children: ReactNode; showOverlay?: boolean }) => (
    <section data-show-overlay={String(showOverlay)}>{children}</section>
  ),
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>
}))

function target(
  hostAuthority: Record<string, unknown> = { kind: 'local' }
): Record<string, unknown> {
  return {
    sessionId: 'child-1',
    startedAt: 1_000,
    paneKey: 'parent\u0000subagent:child-1',
    parentPaneKey: 'parent-pane',
    terminalTabId: 'tab-1',
    worktreeId: 'wt-1',
    label: 'Review files',
    model: 'gpt-5.4-mini',
    hostAuthority
  }
}

function liveSession(): Record<string, unknown> {
  return {
    sessionId: 'child-1',
    agent: 'codex',
    status: 'working',
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        timestamp: 1_000,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Child progress' }]
      }
    ],
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

describe('CodexSubagentProgressSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'codex-subagent-progress'
    mocks.state.modalData = target()
    mocks.state.agentStatusByPaneKey = {}
    mocks.state.agentStatusEpoch = 0
    mocks.liveSession.mockReturnValue(liveSession())
  })

  it('renders a read-only live child transcript on the local transport', async () => {
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).toHaveBeenCalledWith({
      paneKey: 'parent\u0000subagent:child-1',
      agent: 'codex',
      sessionId: 'child-1',
      runtimeEnvironmentId: null
    })
    expect(markup).toContain('Read only')
    expect(markup).toContain('data-testid="message-list"')
    expect(markup).toContain('data-modal="false"')
    expect(markup).toContain('data-show-overlay="false"')
    expect(markup).not.toContain('Send a message')
  })

  it('removes parent turns copied into a full-history child rollout', async () => {
    mocks.liveSession.mockReturnValue({
      ...liveSession(),
      messages: [
        {
          id: 'inherited-parent-message',
          role: 'assistant',
          timestamp: 900,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Parent history' }]
        },
        {
          id: 'child-message',
          role: 'assistant',
          timestamp: 1_100,
          source: 'transcript',
          blocks: [{ type: 'text', text: 'Child progress' }]
        }
      ],
      hasMore: true
    })
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(markup).toContain('data-message-ids="child-message"')
    expect(markup).toContain('data-has-more="false"')
    expect(markup).not.toContain('inherited-parent-message')
  })

  it('routes runtime-owned child transcripts to the resolved remote runtime', async () => {
    mocks.state.modalData = target({ kind: 'runtime', environmentId: 'runtime-env-1' })
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: 'runtime-env-1' })
    )
  })

  it('stops showing a stale working state after the child leaves the live roster', async () => {
    mocks.state.agentStatusByPaneKey = { 'parent-pane': { subagents: [] } }
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(markup).toContain('data-working="false"')
  })

  it('stops showing a captured working state after the parent entry disappears', async () => {
    mocks.state.agentStatusByPaneKey = {}
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(markup).toContain('data-working="false"')
  })

  it('uses a fresh working roster while the transcript is between updates', async () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.state.agentStatusByPaneKey = {
      'parent-pane': {
        updatedAt: now,
        subagents: [{ id: 'child-1', state: 'working' }]
      }
    }
    mocks.liveSession.mockReturnValue({ ...liveSession(), status: 'done' })
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)
    dateNow.mockRestore()

    expect(markup).toContain('data-working="true"')
  })

  it('uses a fresh idle roster over an unfinished long-lived transcript', async () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.state.agentStatusByPaneKey = {
      'parent-pane': {
        updatedAt: now,
        subagents: [{ id: 'child-1', state: 'idle' }]
      }
    }
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)
    dateNow.mockRestore()

    expect(markup).toContain('Idle')
    expect(markup).toContain('data-working="false"')
  })

  it('stops trusting an expired working roster after the freshness epoch advances', async () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    mocks.state.agentStatusEpoch = 1
    mocks.state.agentStatusByPaneKey = {
      'parent-pane': {
        updatedAt: now - AGENT_STATUS_STALE_AFTER_MS - 1,
        subagents: [{ id: 'child-1', state: 'working' }]
      }
    }
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)
    dateNow.mockRestore()

    expect(markup).toContain('data-working="false"')
  })

  it('blocks legacy SSH without attempting a local transcript read', async () => {
    mocks.state.modalData = target({ kind: 'legacy-ssh' })
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).not.toHaveBeenCalled()
    expect(markup).toContain(
      'Live subagent transcripts are not available for legacy SSH workspaces.'
    )
  })

  it('keeps captured runtime routing after the parent and workspace owner disappear', async () => {
    mocks.state.modalData = target({ kind: 'runtime', environmentId: 'runtime-env-1' })
    mocks.state.agentStatusByPaneKey = {}
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: 'runtime-env-1' })
    )
  })
})
