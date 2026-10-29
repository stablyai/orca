import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
import type { openDefaultAgentChatInEmptyWorkspace } from '@/lib/empty-workspace-default-agent-chat'
import { afterEach, expect, it, vi } from 'vitest'
import { dispatchWebRuntimeInitialTerminalBootstrap } from './web-runtime-initial-terminal-bootstrap-dispatch'
import {
  resetWebRuntimeInitialTerminalBootstrapForTests,
  isWebRuntimeInitialTerminalBootstrapInFlight
} from './web-runtime-initial-terminal-bootstrap'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { experimentalNativeChat: true, defaultTuiAgent: 'hermes' },
    activeWorktreeId: 'wt',
    tabsByWorktree: {},
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 0 })
  },
  owner: vi.fn(() => 'env'),
  load: vi.fn(async () => {}),
  open: vi.fn<typeof openDefaultAgentChatInEmptyWorkspace>(() => ({ primaryTabId: null })),
  terminal: vi.fn<() => Promise<WebRuntimeTerminalCreateOutcome>>(async () => ({
    status: 'created'
  }))
}))
vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: mocks.owner
}))
vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.terminal
}))
vi.mock('@/lib/empty-workspace-default-agent-chat', () => ({
  loadEmptyWorkspaceDefaultChatDetection: mocks.load,
  openDefaultAgentChatInEmptyWorkspace: mocks.open
}))
afterEach(() => {
  resetWebRuntimeInitialTerminalBootstrapForTests()
  vi.clearAllMocks()
  mocks.owner.mockReturnValue('env')
  mocks.state.reconcileWorktreeTabModel = () => ({ renderableTabCount: 0 })
  mocks.state.activeWorktreeId = 'wt'
})
it('opens the configured native chat before creating a remote shell and fences duplicate frames', async () => {
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(true)
  expect(mocks.load).toHaveBeenCalledWith('wt')
  expect(mocks.open).toHaveBeenCalledWith('wt', expect.any(Function))
  expect(mocks.terminal).not.toHaveBeenCalled()
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
})
it('does not open the old workspace after navigation during chat discovery', async () => {
  mocks.load.mockImplementationOnce(async () => {
    mocks.state.activeWorktreeId = 'other'
  })
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.terminal).not.toHaveBeenCalled()
})

it('waits for a declined chat fallback and leaves a failed shell retryable', async () => {
  const shell = Promise.withResolvers<WebRuntimeTerminalCreateOutcome>()
  mocks.terminal.mockReturnValueOnce(shell.promise)
  mocks.open.mockImplementationOnce((_worktree, seedShell) => ({
    primaryTabId: null,
    structuredSettlement: Promise.resolve().then(async () => ({
      kind: (await seedShell()) ? 'terminal' : 'cancelled',
      sessionId: null
    }))
  }))
  let settled = false
  const first = dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt').then((result) => {
    settled = true
    return result
  })
  await vi.waitFor(() => expect(mocks.terminal).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  expect(isWebRuntimeInitialTerminalBootstrapInFlight('env', 'wt')).toBe(true)
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  shell.resolve({ status: 'failed', message: 'test host refused terminal' })
  expect(await first).toBe(false)
  expect(isWebRuntimeInitialTerminalBootstrapInFlight('env', 'wt')).toBe(false)
  mocks.open.mockReturnValueOnce(null)
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(true)
  expect(mocks.terminal).toHaveBeenCalledTimes(2)
})

it('does not add a default surface after a user opens a tab during discovery', async () => {
  mocks.load.mockImplementationOnce(async () => {
    mocks.state.reconcileWorktreeTabModel = () => ({ renderableTabCount: 1 })
  })
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.terminal).not.toHaveBeenCalled()
})

it('does not follow a colliding workspace ID to a different host during discovery', async () => {
  mocks.load.mockImplementationOnce(async () => {
    mocks.owner.mockReturnValue('other-env')
  })
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  expect(mocks.open).not.toHaveBeenCalled()
  expect(mocks.terminal).not.toHaveBeenCalled()
})

it('keeps the claim until a successful fallback shell has finished', async () => {
  mocks.open.mockImplementationOnce((_worktree, seedShell) => ({
    primaryTabId: null,
    structuredSettlement: Promise.resolve().then(async () =>
      (await seedShell())
        ? { kind: 'terminal' as const }
        : { kind: 'cancelled' as const, sessionId: null }
    )
  }))
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(true)
  expect(mocks.terminal).toHaveBeenCalledWith({
    worktreeId: 'wt',
    environmentId: 'env',
    activate: true
  })
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  expect(mocks.terminal).toHaveBeenCalledOnce()
})

it('does not create the declined fallback after its workspace moved to another host', async () => {
  mocks.open.mockImplementationOnce((_worktree, seedShell) => ({
    primaryTabId: null,
    structuredSettlement: Promise.resolve().then(async () => {
      mocks.owner.mockReturnValue('other-env')
      return (await seedShell())
        ? { kind: 'terminal' as const }
        : { kind: 'cancelled' as const, sessionId: null }
    })
  }))
  expect(await dispatchWebRuntimeInitialTerminalBootstrap('env', 'wt')).toBe(false)
  expect(mocks.terminal).not.toHaveBeenCalled()
})
