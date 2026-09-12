import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { sendCanvasContext } from './agent-canvas-delivery'

const mocks = vi.hoisted(() => ({ route: vi.fn(), find: vi.fn(), send: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { activeRuntimeEnvironmentId: 'wrong-host' } }) }
}))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRouteResultForHost: mocks.route,
  settingsForWorktreeOperationRoute: (
    _settings: unknown,
    route: { runtimeEnvironmentId: string | null }
  ) => ({ activeRuntimeEnvironmentId: route.runtimeEnvironmentId })
}))
vi.mock('@/runtime/runtime-rpc-client', async () => await import('@/runtime/runtime-client-target'))
vi.mock('@/lib/active-agent-note-target', () => ({ findActiveRuntimeTerminal: mocks.find }))
vi.mock('@/lib/active-agent-note-send-delivery', () => ({
  sendPromptWithGuardedPasteAndEnter: mocks.send
}))

const card: DashboardCard = {
  paneKey: 'tab:leaf',
  agentType: 'codex',
  bucket: 'working',
  dotState: 'working',
  task: 'Review',
  repoId: 'repo',
  repoName: 'Project',
  worktreeName: 'Folder',
  startedAt: 0,
  finishedAt: null,
  stateChangedAt: 0,
  unseen: false,
  executionHostId: 'runtime:worker-host',
  worktreeId: 'folder:workspace',
  tabId: 'tab',
  leafId: 'leaf',
  ptyId: 'pty'
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.mockReturnValue({
    kind: 'resolved',
    route: { executionHostId: 'runtime:worker-host', runtimeEnvironmentId: 'worker-host' }
  })
  mocks.find.mockResolvedValue({ handle: 'exact-handle', ptyId: 'pty' })
  mocks.send.mockResolvedValue({ status: 'sent' })
})

describe('canvas context delivery', () => {
  it('routes to the selected session owner even when another runtime is active', async () => {
    await sendCanvasContext(card, 'Review the API')
    expect(mocks.route).toHaveBeenCalledWith(
      expect.anything(),
      'folder:workspace',
      'runtime:worker-host'
    )
    expect(mocks.send).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'worker-host' },
      'exact-handle',
      'Review the API',
      { allowLegacyFallback: false }
    )
  })
  it('does not substitute local execution when the target is unavailable', async () => {
    mocks.route.mockReturnValue({ kind: 'missing' })
    await expect(sendCanvasContext(card, 'Review')).rejects.toThrow('unavailable')
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('refuses a replacement process in the same terminal pane', async () => {
    mocks.find.mockResolvedValue({ handle: 'replacement', ptyId: 'new-pty' })
    await expect(sendCanvasContext(card, 'Review')).rejects.toThrow('session changed')
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it('does not claim success or retry after partial submission', async () => {
    mocks.send.mockResolvedValue({ status: 'partial-submit-failed' })
    await expect(sendCanvasContext(card, 'Review')).rejects.toThrow('may already be pasted')
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })
  it('refuses a card without authoritative routing identity', async () => {
    await expect(
      sendCanvasContext({ ...card, executionHostId: undefined }, 'Review')
    ).rejects.toThrow('verified terminal')
    expect(mocks.route).not.toHaveBeenCalled()
  })
})
