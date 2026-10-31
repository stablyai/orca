// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
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
import { inPlaceSwitchCapability } from '../../../../shared/structured-agent-cli-conversation-adoption'
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
  panes: vi.fn(() => [])
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
vi.mock('@/lib/conversation-surface-switch', () => ({
  runConversationSwitch: mocks.startOwner,
  runCliChatResume: mocks.run,
  useConversationSwitchReadiness: () => ({ ready: true, pending: false })
}))
vi.mock('../tab-bar/cli-chat-resume-source', () => ({ resolveCliChatResumeSource: mocks.source }))
vi.mock('@/lib/ai-vault-tab-title-requests', async (original) => ({
  ...(await original<object>()),
  collectAgentPaneConversations: mocks.panes
}))

const SWITCH = inPlaceSwitchCapability('codex')
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
    settings: createGlobalSettingsFixture({ ...state.settings })
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
  useAppStore.setState({ settings: createGlobalSettingsFixture() })
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
  'routes the owned %s History action to the common switcher',
  async (host) => {
    mocks.owner.mockReturnValue(host)
    useAppStore.setState({
      runtimeEnvironments: [paired],
      runtimeStatusByEnvironmentId: new Map([['paired', pairedHistoryStatus()]])
    })
    render(<History session={{ ...row, executionHostId: host }} />)
    const button = await screen.findByRole('button', { name: 'Switch to Chat UI' })
    expect(button.hasAttribute('disabled')).toBe(false)
    await userEvent.setup().click(button)
    expect(mocks.startOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'chat',
        sessionId: 'owner',
        workspaceId: 'workspace',
        executionHostId: host
      })
    )
  }
)
