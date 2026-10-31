import { createElement } from 'react'
import AiVaultSessionDropLayer from '../tab-group/AiVaultSessionDropLayer'
import { writeAiVaultSessionDragData } from '@/lib/ai-vault-session-drag'
import type * as ForkStartup from '@/lib/ai-vault-session-fork-startup'
// @vitest-environment happy-dom
import { cleanup, render, fireEvent, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { WebRuntimeTerminalCreateOutcome } from '@/runtime/web-runtime-session-types'

const mocks = vi.hoisted(() => ({
  buildAiVaultForkStartupForWorktree: vi.fn(),
  getState: vi.fn(),
  buildAiVaultResumeStartupForWorktree: vi.fn(),
  prepareAiVaultSessionForFork: vi.fn(),
  prepareAiVaultSessionForResume: vi.fn(),
  prepareAiVaultSessionForTerminalResume: vi.fn(),
  launchAiVaultSessionInNewTab: vi.fn(),
  activateAiVaultResumeWorkspace: vi.fn(),
  rpc: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/lib/ai-vault-session-fork-startup', async (importOriginal) => ({
  ...(await importOriginal<typeof ForkStartup>()),
  buildAiVaultCopiedSessionStartupForWorktree: (args: { session: AiVaultSession }) => ({
    ...mocks.buildAiVaultResumeStartupForWorktree(args),
    agent: args.session.agent
  }),
  buildAiVaultForkStartupForWorktree: mocks.buildAiVaultForkStartupForWorktree
}))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  resolveAiVaultResumeHost: () => ({ platform: 'linux', codexHome: null, liveShell: undefined }),
  buildAiVaultResumeStartupForWorktree: mocks.buildAiVaultResumeStartupForWorktree,
  buildAiVaultResumeCopyCommandForWorktree: vi.fn()
}))
vi.mock('@/lib/ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForFork: mocks.prepareAiVaultSessionForFork,
  prepareAiVaultSessionForResume: mocks.prepareAiVaultSessionForResume,
  prepareAiVaultSessionForTerminalResume: mocks.prepareAiVaultSessionForTerminalResume,
  dropDeletedRemoteResumeCwd: async (session: unknown) => session,
  aiVaultCliForkHostTooOldMessage: () =>
    'Update Orca on the host that runs this chat to resume it in a new CLI.'
}))
vi.mock('@/lib/launch-ai-vault-session', () => ({
  launchAiVaultSessionInNewTab: mocks.launchAiVaultSessionInNewTab
}))
vi.mock('./ai-vault-session-launch-target', () => ({
  resolveAiVaultSessionLaunchTarget: (args: { targetWorktreeId?: string }) => ({
    status: 'ready',
    worktreeId: args.targetWorktreeId
  }),
  resolveAiVaultTargetWorkspacePath: vi.fn(),
  aiVaultResumeUnsupportedMessage: vi.fn()
}))
vi.mock('./ai-vault-session-resume-in-chat-launch', () => ({
  activateAiVaultResumeWorkspace: mocks.activateAiVaultResumeWorkspace,
  resumeAiVaultSessionInNewChat: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

import { useAiVaultSessionLaunchActions } from './ai-vault-session-launch-actions'

const owned: AiVaultSession = {
  id: 'local:claude:provider-1:/p.jsonl',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'provider-1',
  title: 'Claude Chat',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/p.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-07T00:00:00.000Z',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume provider-1',
  subagent: null,
  structuredSession: { sessionId: 'chat-1', workspaceId: 'worktree-1' }
}

const FORK_STARTUP = { command: "claude --resume 'provider-1' --fork-session", cwd: '/repo' }

function renderActions(agentCmdOverrides?: { opencode?: string }) {
  return renderHook(() =>
    useAiVaultSessionLaunchActions({
      activeWorktree: null,
      activeWorktreeId: 'worktree-1',
      agentCmdOverrides,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked launch target never reads it.
      targetState: {} as never
    })
  ).result.current
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getState.mockReturnValue({ activeWorktreeId: 'worktree-1', settings: {} })
  mocks.prepareAiVaultSessionForFork.mockImplementation(async (session) => ({
    session,
    copied: false
  }))
  mocks.buildAiVaultForkStartupForWorktree.mockReturnValue(FORK_STARTUP)
  mocks.launchAiVaultSessionInNewTab.mockReturnValue({ tabId: 'tab-1' })
  mocks.rpc.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('Switch to Terminal launch', () => {
  // Either OpenCode chat may own a 2.x conversation, so the copy may open in either CLI.
  it.each([
    ['command', 'opencode'],
    ['arguments', 'opencode'],
    ['command', 'opencode2'],
    ['arguments', 'opencode2']
  ] as const)(
    'refuses %s server routing on %s before asking for any copy',
    async (location, cli) => {
      const chat = { ...owned, agent: 'opencode2' as const }
      const agentCmdOverrides =
        location === 'command' ? { [cli]: `${cli} --server http://synthetic-server` } : {}
      mocks.getState.mockReturnValue({
        activeWorktreeId: 'worktree-1',
        settings: {
          agentCmdOverrides,
          agentDefaultArgs:
            location === 'arguments' ? { [cli]: '--server=http://synthetic-server' } : {}
        }
      })
      renderActions(agentCmdOverrides).handleResumeInNewCli(chat, 'worktree-2')
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('Remove --server'))
      expect(mocks.prepareAiVaultSessionForFork).not.toHaveBeenCalled()
      expect(mocks.launchAiVaultSessionInNewTab).not.toHaveBeenCalled()
    }
  )

  it('opens the fork plan in the chosen workspace, never the plain resume plan', async () => {
    renderActions().handleResumeInNewCli(owned, 'worktree-2')

    await waitFor(() => expect(mocks.launchAiVaultSessionInNewTab).toHaveBeenCalledTimes(1))
    expect(mocks.prepareAiVaultSessionForFork).toHaveBeenCalledWith(owned)
    expect(mocks.buildAiVaultForkStartupForWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'worktree-2', session: owned })
    )
    expect(mocks.launchAiVaultSessionInNewTab).toHaveBeenCalledWith({
      agent: 'claude',
      worktreeId: 'worktree-2',
      ...FORK_STARTUP
    })
    expect(mocks.activateAiVaultResumeWorkspace).toHaveBeenCalledWith('worktree-2')
    expect(mocks.prepareAiVaultSessionForResume).not.toHaveBeenCalled()
    expect(mocks.buildAiVaultResumeStartupForWorktree).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each(['omp', 'opencode2'] as const)(
    'opens the %s copy with the actual CLI in the chosen workspace',
    async (agent) => {
      const chat = { ...owned, agent, executionHostId: 'runtime:paired-host' as const }
      const copy = {
        ...chat,
        agent: agent === 'omp' ? ('omp' as const) : ('opencode' as const),
        sessionId: 'copy-1'
      }
      const startup = {
        command: `${copy.agent} --resume copy-1`,
        providerSession: { key: 'session_id', id: 'copy-1' }
      }
      mocks.prepareAiVaultSessionForFork.mockResolvedValue({ session: copy, copied: true })
      mocks.buildAiVaultResumeStartupForWorktree.mockReturnValue(startup)
      renderActions({ opencode: 'opencode --server http://synthetic-server' }).handleResumeInNewCli(
        chat,
        'worktree-2'
      )
      await waitFor(() => expect(mocks.launchAiVaultSessionInNewTab).toHaveBeenCalledTimes(1))
      expect(mocks.launchAiVaultSessionInNewTab).toHaveBeenCalledWith({
        agent: copy.agent,
        worktreeId: 'worktree-2',
        ...startup
      })
      expect(mocks.buildAiVaultForkStartupForWorktree).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it('shows one toast and opens nothing when the agent cannot fork', async () => {
    mocks.buildAiVaultForkStartupForWorktree.mockReturnValue(null)

    renderActions().handleResumeInNewCli(owned, 'worktree-2')

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith('This session cannot be opened in the CLI.')
    expect(mocks.launchAiVaultSessionInNewTab).not.toHaveBeenCalled()
  })

  it('asks for a host update, once, when an older paired host refuses the fork', async () => {
    mocks.launchAiVaultSessionInNewTab.mockReturnValue({
      tabId: null,
      runtimeLaunch: Promise.resolve<WebRuntimeTerminalCreateOutcome>({
        status: 'failed',
        message: 'agent_session_conflict'
      })
    })

    renderActions().handleResumeInNewCli(owned, 'worktree-2')

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Update Orca on the host that runs this chat to resume it in a new CLI.'
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('asks for a host update when an older paired host refuses the fork preparation', async () => {
    mocks.prepareAiVaultSessionForFork.mockRejectedValue(new Error('agent_session_conflict'))

    renderActions().handleResumeInNewCli(owned, 'worktree-2')

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Update Orca on the host that runs this chat to resume it in a new CLI.'
    )
    expect(mocks.launchAiVaultSessionInNewTab).not.toHaveBeenCalled()
  })
})

it('refuses the stale OMP row before creating a second terminal writer', async () => {
  mocks.prepareAiVaultSessionForTerminalResume.mockRejectedValue(
    new Error(
      "Error invoking remote method 'aiVault:prepareSessionResume': Error: agent_session_conflict"
    )
  )
  renderActions().handleResume(
    { ...owned, agent: 'omp', structuredSession: undefined },
    'worktree-1'
  )
  await waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
  expect(mocks.toastError).toHaveBeenCalledWith(
    'This OMP conversation is open in a chat. Refresh Session History to open it.'
  )
  expect(mocks.launchAiVaultSessionInNewTab).not.toHaveBeenCalled()
})

it('intercepts an ordinary structured Resume and actual pane drop on handled refusal without terminal execution', async () => {
  mocks.getState.mockReturnValue({
    activeWorktreeId: 'worktree-1',
    settings: {},
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    unifiedTabsByWorktree: {}
  })
  mocks.rpc.mockImplementation(async (_target, method) => {
    if (method === 'session.tabs.list') {
      throw new Error('advisory inventory unavailable')
    }
    return { ok: false, refusal: { code: 'agent_session_identity_required' } }
  })
  const actions = renderActions()
  actions.handleResume(owned)
  await waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('no longer on this host')
    )
  )
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 100, 100))
  try {
    const view = render(
      createElement(
        'div',
        { 'data-tab-group-body-id': 'group', 'data-worktree-id': 'worktree-1' },
        createElement(AiVaultSessionDropLayer, { worktreeId: 'worktree-1', enabled: true })
      )
    )
    try {
      const transfer = new DataTransfer()
      writeAiVaultSessionDragData(transfer, {
        agent: 'claude',
        sessionId: owned.sessionId,
        structuredSession: owned.structuredSession,
        title: owned.title,
        command: ''
      })
      const layer = view.container.querySelector('[data-ai-vault-session-drop-layer]')
      if (!layer) {
        throw new Error('drop layer must mount')
      }
      const drop = new MouseEvent('drop', {
        clientX: 50,
        clientY: 50,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(drop, 'dataTransfer', { value: transfer })
      fireEvent(layer, drop)
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(2))
      expect(mocks.launchAiVaultSessionInNewTab).not.toHaveBeenCalled()
      expect(mocks.prepareAiVaultSessionForTerminalResume).not.toHaveBeenCalled()
    } finally {
      view.unmount()
    }
  } finally {
    rect.mockRestore()
  }
})
