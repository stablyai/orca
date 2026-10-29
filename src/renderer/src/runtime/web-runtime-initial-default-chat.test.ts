import { afterEach, expect, it, vi } from 'vitest'
import { dispatchWebRuntimeInitialTerminalBootstrap } from './web-runtime-initial-terminal-bootstrap-dispatch'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from './web-runtime-initial-terminal-bootstrap'

const mocks = vi.hoisted(() => ({
  state: {
    settings: { experimentalNativeChat: true, defaultTuiAgent: 'hermes' },
    activeWorktreeId: 'wt',
    tabsByWorktree: {}
  },
  load: vi.fn(async () => {}),
  open: vi.fn(() => ({ primaryTabId: null })),
  terminal: vi.fn(async () => ({ status: 'created' }))
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
