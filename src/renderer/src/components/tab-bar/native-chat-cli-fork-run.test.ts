import { beforeEach, expect, it, vi } from 'vitest'
import { runNativeChatCliFork } from './native-chat-cli-fork-run'
import type * as LaunchFeedback from '../right-sidebar/ai-vault-session-launch-feedback'
import type {
  NativeChatCliForkPreparation,
  NativeChatCliForkSubject
} from '@/lib/native-chat-cli-fork-preparation'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  launch: vi.fn(),
  notify: vi.fn(),
  activate: vi.fn(),
  activeWorktreeId: 'workspace-1',
  error: vi.fn(),
  open: true,
  host: 'runtime:peer',
  listeners: new Set<() => void>()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: mocks.activeWorktreeId,
      unifiedTabsByWorktree: {
        'workspace-1': mocks.open
          ? [{ id: 'tab-1', contentType: 'agent-session', entityId: 'chat-1' }]
          : []
      }
    }),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('./tab-session-history-switch', () => ({
  resolveNativeChatCliForkIdentity: () => ({ executionHostScope: mocks.host }),
  resolveTabSessionHistorySubject: () => {
    throw new Error('History projection in currentness')
  }
}))
vi.mock('@/lib/native-chat-cli-fork-preparation', () => ({
  prepareNativeChatCliFork: mocks.prepare
}))
vi.mock('@/lib/ai-vault-session-fork-startup', () => ({
  assertAiVaultCopiedSessionLaunchAllowed: () => {},
  buildAiVaultForkStartupForWorktree: () => ({ command: 'claude --resume source --fork-session' }),
  buildAiVaultCopiedSessionStartupForWorktree: () => ({ command: 'omp --resume copy' })
}))
vi.mock('../right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  activateAiVaultResumeWorkspace: mocks.activate
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('../right-sidebar/ai-vault-session-launch-feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchFeedback>()
  return { ...actual, notifyAiVaultSessionQueued: mocks.notify }
})

const subject: NativeChatCliForkSubject = {
  kind: 'chat',
  sessionId: 'chat-1',
  workspaceId: 'workspace-1',
  request: { executionHostScope: 'runtime:peer', scopePaths: ['/host/repo'], sessionLimit: 250 }
}
const args = { subject, tab: { id: 'tab-1', worktreeId: 'workspace-1' }, agent: 'claude' } as const
const prepared: NativeChatCliForkPreparation = {
  session: { agent: 'claude', sessionId: 'source', cwd: '/host/repo', codexHome: null },
  copied: false
}
beforeEach(() => {
  mocks.open = true
  mocks.activeWorktreeId = 'workspace-1'
  mocks.activate.mockReset()
  mocks.prepare.mockReset()
  mocks.launch.mockReset().mockReturnValue({ tabId: 'destination' })
  mocks.notify.mockReset()
  mocks.error.mockReset()
  replaceRuntimeEnvironmentRevisions([{ id: 'peer', createdAt: 1, pairingRevision: 7 }])
})
function closeSource() {
  mocks.open = false
  mocks.listeners.forEach((listener) => listener())
}

it('shares pending across menu openings and suppresses dispatch after source retirement', async () => {
  let settle = (_value: NativeChatCliForkPreparation) => {}
  mocks.prepare.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve
    })
  )
  const first = runNativeChatCliFork(args)
  await runNativeChatCliFork(args)
  expect(mocks.prepare).toHaveBeenCalledTimes(1)
  mocks.listeners.forEach((listener) => listener())
  expect(mocks.error).not.toHaveBeenCalled()
  closeSource()
  settle(prepared)
  await first
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})

it('retires preparation when the initiating pairing changes', async () => {
  let settle = (_value: NativeChatCliForkPreparation) => {}
  mocks.prepare.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve
    })
  )
  const running = runNativeChatCliFork(args)
  replaceRuntimeEnvironmentRevisions([{ id: 'peer', createdAt: 1, pairingRevision: 8 }])
  settle(prepared)
  await running
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(mocks.error).not.toHaveBeenCalled()
})

it('lets the destination finish after dispatch and passes no source resume identity', async () => {
  mocks.prepare.mockResolvedValue(prepared)
  mocks.launch.mockImplementation(() => {
    closeSource()
    return { tabId: null, runtimeLaunch: Promise.resolve({ status: 'created' }) }
  })
  await runNativeChatCliFork(args)
  expect(mocks.launch).toHaveBeenCalledWith({
    agent: 'claude',
    worktreeId: 'workspace-1',
    command: 'claude --resume source --fork-session'
  })
  expect(mocks.notify).toHaveBeenCalledWith('claude')
  expect(mocks.error).not.toHaveBeenCalled()
})

it('reveals the successful source workspace after another workspace was selected', async () => {
  mocks.prepare.mockImplementation(async () => {
    mocks.activeWorktreeId = 'workspace-2'
    return prepared
  })
  await runNativeChatCliFork(args)
  expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('workspace-1')
  mocks.activate.mockClear()
  mocks.notify.mockClear()
  mocks.launch.mockReturnValue({
    tabId: null,
    runtimeLaunch: Promise.resolve({ status: 'failed', message: 'refused' })
  })
  await runNativeChatCliFork(args)
  expect(mocks.activate).not.toHaveBeenCalled()
  expect(mocks.notify).not.toHaveBeenCalled()
  expect(mocks.error).toHaveBeenCalledTimes(1)
})

it.each([
  {
    agent: 'claude' as const,
    message: 'execution_owner_reconciling',
    expected: 'Orca could not prepare this Claude conversation. Start a new chat to continue.'
  },
  {
    agent: 'codex' as const,
    message:
      "Error invoking remote method 'aiVault:prepareSessionResume': Error: execution_owner_reconciling",
    expected: 'Orca could not prepare this Codex conversation. Start a new chat to continue.'
  },
  {
    agent: 'claude' as const,
    message: 'agent_session_conflict',
    expected: 'Update Orca on the host that runs this chat to resume it in a new CLI.'
  },
  {
    agent: 'codex' as const,
    message:
      "Error invoking remote method 'aiVault:prepareSessionResume': Error: agent_session_ownership_unknown",
    expected: 'Update Orca on the host that runs this chat to resume it in a new CLI.'
  },
  {
    agent: 'claude' as const,
    message: 'The session host is unavailable. Reconnect it and retry resume.',
    expected: 'The session host is unavailable. Reconnect it and retry resume.'
  }
])(
  'shows actionable $agent preparation feedback for $message and releases pending',
  async ({ agent, message, expected }) => {
    const onComplete = vi.fn()
    mocks.prepare.mockRejectedValue(new Error(message))
    await runNativeChatCliFork({ ...args, agent, onComplete })
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(expected)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(mocks.listeners.size).toBe(0)

    await runNativeChatCliFork({ ...args, agent, onComplete })
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(mocks.error.mock.calls).toEqual([[expected], [expected]])
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(2)
    expect(mocks.listeners.size).toBe(0)
  }
)
