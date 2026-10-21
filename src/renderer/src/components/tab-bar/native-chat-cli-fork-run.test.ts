import { beforeEach, expect, it, vi } from 'vitest'
import { runNativeChatCliFork } from './native-chat-cli-fork-run'
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
  resolveTabSessionHistorySubject: () => ({
    kind: 'chat',
    request: { executionHostScope: mocks.host }
  })
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
vi.mock('../right-sidebar/ai-vault-session-launch-feedback', () => ({
  notifyAiVaultSessionQueued: mocks.notify,
  notifyAiVaultSessionPreparationFailure: mocks.error
}))

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
