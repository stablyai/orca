// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import {
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY as HISTORY } from '../../../../shared/protocol-version'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { AiVaultVirtualRow } from './AiVaultVirtualRow'
import { useAiVaultPanelSessionResume } from './use-ai-vault-panel-session-resume'
import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'

const mocks = vi.hoisted(() => ({
  probe: vi.fn<() => Promise<boolean>>(),
  owner: vi.fn<() => string | null>(() => 'local'),
  newChat: vi.fn(),
  fork: vi.fn(),
  startOwner: vi.fn(async () => false),
  run: vi.fn(),
  source: vi.fn(),
  panes: vi.fn<
    () => {
      providerSession: { id: string }
      agent: 'codex'
      executionHostId: 'runtime:paired'
      tabId: string
      worktreeId: string
      paneKey: string
    }[]
  >(() => [])
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.probe,
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<object>()),
  resolveStructuredAgentSessionOwner: mocks.owner
}))
// Ordinary route feasibility has its own contracts; these tests exercise the History gates above it.
vi.mock('@/lib/agent-session-launch-plan', async (original) => ({
  ...(await original<object>()),
  structuredAgentSessionLaunchFeasible: () => true
}))
vi.mock('./ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.newChat
}))
vi.mock('../tab-bar/cli-chat-resume-feedback', () => ({ switchIntoOwner: mocks.startOwner }))
vi.mock('../tab-bar/cli-chat-resume-run', () => ({ runCliChatResume: mocks.run }))
vi.mock('../tab-bar/cli-chat-resume-source', () => ({ resolveCliChatResumeSource: mocks.source }))
vi.mock('@/lib/ai-vault-tab-title-requests', async (original) => ({
  ...(await original<object>()),
  collectAgentPaneConversations: mocks.panes
}))

const SWITCH = 'agent-session.structured.switch.v1:codex'
const paired = {
  id: 'paired',
  name: 'Paired',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: 'paired',
  preferredEndpointId: 'endpoint',
  endpoints: [{ id: 'endpoint', kind: 'websocket' as const, label: 'Host', endpoint: 'ws://host' }]
}

const row: AiVaultSession = {
  id: 'codex-history',
  agent: 'codex',
  sessionId: 'conversation',
  executionHostId: 'local',
  structuredSession: { sessionId: 'owner', workspaceId: 'workspace' },
  title: 'Conversation',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/rollout.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-21T00:00:00Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}
function History({ session }: { session: AiVaultSession }) {
  const state = useAppStore.getState()
  const targetState = {
    ...state,
    repos: [],
    worktreesByRepo: {
      repo: [makeWorktree({ id: 'workspace', repoId: 'repo', path: '/repo', hostId: 'local' })]
    },
    folderWorkspaces: [],
    projectGroups: []
  }
  const resume = useAiVaultPanelSessionResume({
    sessions: [session],
    repos: [],
    allWorktrees: [],
    workspaceId: 'workspace',
    resumeTargetState: targetState,
    settings: createGlobalSettingsFixture({ ...state.settings, experimentalNativeChat: true })
  })
  const actions = useAiVaultSessionLaunchActions({
    activeWorktree: null,
    activeWorktreeId: 'workspace',
    targetState
  })
  return (
    <TooltipProvider>
      <AiVaultVirtualRow
        row={{ type: 'session', groupKey: 'today', session }}
        index={0}
        start={0}
        activeStickyHeaderIndex={null}
        measureElement={vi.fn()}
        collapsedGroups={new Set()}
        expandedSessionIds={new Set([session.id])}
        vaultScope="all"
        buildResumeStartup={actions.buildResumeStartup}
        getOriginalPaneTarget={() => null}
        isStructuredSessionOpen={() => false}
        getSessionLiveState={() => null}
        getWorktreeInfo={resume.getSessionWorktreeInfo}
        getSessionResumeState={resume.getSessionResumeState}
        getSessionResumeActions={resume.getSessionResumeActions}
        getSessionResumeInChat={resume.getSessionResumeInChat}
        onToggleGroup={vi.fn()}
        onToggleSessionDetails={vi.fn()}
        onJumpToOriginalPane={vi.fn()}
        onJumpToWorktree={vi.fn()}
        onResume={vi.fn()}
        onContinueInNewSession={vi.fn()}
        onResumeInNewChat={actions.handleResumeInNewChat}
        onResumeInNewCli={mocks.fork}
        onCopyResume={vi.fn()}
        onCopyId={vi.fn()}
        onCopyPath={vi.fn()}
        onOpenLog={vi.fn()}
        onRevealLog={vi.fn()}
        onOpenCwd={vi.fn()}
        onRequestDelete={vi.fn()}
      />
    </TooltipProvider>
  )
}
beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(window, {
    api: {
      ...window.api,
      aiVault: {},
      runtime: { getStatus: async () => ({ capabilities: [HISTORY, SWITCH] }) }
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: createGlobalSettingsFixture({ experimentalNativeChat: true }) })
  setLocalRuntimeCapabilitiesForTests([HISTORY, SWITCH])
  await refreshLocalRuntimeCapabilities()
  mocks.owner.mockReturnValue('local')
  mocks.probe.mockResolvedValue(true)
  mocks.source.mockReturnValue(null)
  mocks.panes.mockReturnValue([])
})
afterEach(cleanup)

function pairedHistoryStatus() {
  const response = createCompatibleRuntimeStatusResponse('paired')
  if (!response.ok) {
    throw new Error('Expected status fixture')
  }
  return { status: { ...response.result, capabilities: [HISTORY, SWITCH] }, checkedAt: 1 }
}

it.each(['local', 'runtime:paired'] as const)(
  'composes the owned %s row/details/menu and refreshes unknown capability',
  async (host) => {
    mocks.owner.mockReturnValue(host)
    useAppStore.setState({
      runtimeEnvironments: [paired],
      runtimeStatusByEnvironmentId: new Map([['paired', pairedHistoryStatus()]])
    })
    setLocalRuntimeCapabilitiesForTests(null)
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
    let answer = (_value: { capabilities: string[] }) => {}
    Object.assign(window.api.runtime, {
      getStatus: () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    const session = { ...row, executionHostId: host }
    render(<History session={session} />)
    expect(screen.queryByRole('button', { name: 'Switch to native chat' })).toBeNull()
    await act(async () => {
      answer({ capabilities: [HISTORY, SWITCH] })
      if (host !== 'local') {
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map([['paired', pairedHistoryStatus()]])
        })
      }
    })
    const button = await screen.findByRole('button', { name: 'Switch to native chat' })
    expect(button.hasAttribute('disabled')).toBe(false)
    await userEvent.setup().click(button)
    expect(mocks.startOwner).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace' }),
      row.structuredSession,
      host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'paired' }
    )
    await userEvent.setup().click(screen.getByTestId('ai-vault-session-more-actions'))
    await userEvent
      .setup()
      .click(await screen.findByRole('menuitem', { name: 'Switch to native chat' }))
    expect(mocks.startOwner).toHaveBeenCalledTimes(2)
    fireEvent.contextMenu(screen.getByText('Conversation'))
    await userEvent
      .setup()
      .click(await screen.findByRole('menuitem', { name: 'Switch to native chat' }))
    expect(mocks.startOwner).toHaveBeenCalledTimes(3)
  }
)

it('routes a capable paired unowned row with a matching terminal through the same return', async () => {
  mocks.owner.mockReturnValue('runtime:paired')
  useAppStore.setState({
    runtimeEnvironments: [paired],
    runtimeStatusByEnvironmentId: new Map([['paired', pairedHistoryStatus()]])
  })
  const session = {
    ...row,
    structuredSession: undefined,
    executionHostId: 'runtime:paired' as const
  }
  const source = {
    agent: 'codex',
    tabId: 'terminal',
    workspaceId: 'workspace',
    paneKey: 'terminal:leaf',
    executionHostId: 'runtime:paired',
    providerSessionId: 'conversation'
  }
  mocks.panes.mockReturnValue([
    {
      providerSession: { id: 'conversation' },
      agent: 'codex',
      executionHostId: 'runtime:paired',
      tabId: 'terminal',
      worktreeId: 'workspace',
      paneKey: 'terminal:leaf'
    }
  ])
  mocks.source.mockReturnValue(source)
  render(<History session={session} />)
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Switch to native chat' }).hasAttribute('disabled')
    ).toBe(false)
  )
  await userEvent.setup().click(screen.getByRole('button', { name: 'Switch to native chat' }))
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith(source)
})

it.each([
  {
    executionHostId: 'runtime:paired' as const,
    agent: 'codex' as const,
    filePath: '/rollout.jsonl'
  },
  { executionHostId: 'ssh:box' as const, agent: 'codex' as const, filePath: '/rollout.jsonl' },
  {
    executionHostId: 'local' as const,
    agent: 'codex' as const,
    filePath: '//wsl.localhost/Ubuntu/rollout.jsonl'
  },
  { executionHostId: 'local' as const, agent: 'omp' as const, filePath: '/session.jsonl' }
])('keeps ordinary restrictions for an unsupported owned row: %s', async (overrides) => {
  setLocalRuntimeCapabilitiesForTests([HISTORY])
  mocks.probe.mockResolvedValue(false)
  mocks.owner.mockReturnValue(
    overrides.executionHostId.startsWith('ssh:') ? null : overrides.executionHostId
  )
  render(<History session={{ ...row, ...overrides }} />)
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Switch to native chat' })).toBeNull()
  )
  expect(mocks.run).not.toHaveBeenCalled()
  expect(mocks.startOwner).not.toHaveBeenCalled()
})

it.each(['codex', 'claude', 'grok', 'omp', 'opencode', 'opencode2', 'pi'] as const)(
  'keeps ordinary local History resume and owned fork usable for %s',
  async (agent) => {
    setLocalRuntimeCapabilitiesForTests([HISTORY])
    mocks.probe.mockResolvedValue(false)
    const session = { ...row, agent, structuredSession: undefined }
    const view = render(<History session={session} />)
    const resume = await screen.findByRole('button', { name: 'Resume in New Chat' })
    await userEvent.setup().click(resume)
    expect(mocks.newChat).toHaveBeenCalledExactlyOnceWith(
      session,
      agent,
      'workspace',
      expect.any(String)
    )
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.startOwner).not.toHaveBeenCalled()
    view.rerender(<History session={{ ...session, structuredSession: row.structuredSession }} />)
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Resume in New Terminal' }))
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Switch to CLI' })).toBeNull()
  }
)
