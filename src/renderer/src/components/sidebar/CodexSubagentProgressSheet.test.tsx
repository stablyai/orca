import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'codex-subagent-progress',
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    agentStatusByPaneKey: {} as Record<string, unknown>
  },
  inferredConnectionId: null as string | null | undefined,
  runtimeEnvironmentId: null as string | null,
  liveSession: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => mocks.inferredConnectionId
}))

vi.mock('@/components/native-chat/native-chat-runtime-owner', () => ({
  selectNativeChatRuntimeEnvironmentId: () => mocks.runtimeEnvironmentId
}))

vi.mock('@/components/native-chat/use-native-chat-live-session', () => ({
  useNativeChatLiveSession: mocks.liveSession
}))

vi.mock('@/components/native-chat/NativeChatMessageList', () => ({
  NativeChatMessageList: ({ isWorking }: { isWorking: boolean }) => (
    <div data-testid="message-list" data-working={isWorking ? 'true' : 'false'} />
  )
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>
}))

function target(connectionId: string | null | undefined): Record<string, unknown> {
  return {
    sessionId: 'child-1',
    paneKey: 'parent\u0000subagent:child-1',
    parentPaneKey: 'parent-pane',
    terminalTabId: 'tab-1',
    worktreeId: 'wt-1',
    label: 'Review files',
    model: 'gpt-5.4-mini',
    state: 'working',
    ...(connectionId === undefined ? {} : { connectionId })
  }
}

function liveSession(): Record<string, unknown> {
  return {
    sessionId: 'child-1',
    agent: 'codex',
    status: 'working',
    messages: [{ id: 'message-1' }],
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
    mocks.state.modalData = target(null)
    mocks.state.agentStatusByPaneKey = {}
    mocks.inferredConnectionId = null
    mocks.runtimeEnvironmentId = null
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
    expect(markup).not.toContain('Send a message')
  })

  it('routes runtime-owned child transcripts to the resolved remote runtime', async () => {
    mocks.state.modalData = target('runtime-ssh-target-1')
    mocks.runtimeEnvironmentId = 'runtime-env-1'
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: 'runtime-env-1' })
    )
  })

  it('stops showing a stale working state after the child leaves the live roster', async () => {
    mocks.state.agentStatusByPaneKey = { 'parent-pane': { subagents: [] } }
    mocks.liveSession.mockReturnValue({ ...liveSession(), status: 'done' })
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(markup).toContain('data-working="false"')
  })

  it('blocks legacy SSH without attempting a local transcript read', async () => {
    mocks.state.modalData = target('ssh-target-1')
    const { default: CodexSubagentProgressSheet } = await import('./CodexSubagentProgressSheet')

    const markup = renderToStaticMarkup(<CodexSubagentProgressSheet />)

    expect(mocks.liveSession).not.toHaveBeenCalled()
    expect(markup).toContain(
      'Live subagent transcripts are not available for legacy SSH workspaces.'
    )
  })
})
