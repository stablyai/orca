import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { launchCanvasAgent } from './launch-canvas-agent'

const mocks = vi.hoisted(() => ({
  local: vi.fn(),
  remote: vi.fn(),
  route: vi.fn(),
  activate: vi.fn(),
  focus: vi.fn(),
  host: 'local'
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: 'folder:one',
      activeWorkspaceExecutionHostId: mocks.host,
      activateTab: mocks.activate,
      focusGroup: mocks.focus,
      setActiveTabType: vi.fn()
    })
  }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.local }))
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRouteResultForHost: mocks.route
}))
vi.mock('@/runtime/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.remote
}))

const tab: Tab = {
  id: 'canvas',
  entityId: 'canvas',
  groupId: 'group',
  worktreeId: 'folder:one',
  executionHostId: 'local',
  contentType: 'canvas',
  label: 'Canvas',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.host = 'local'
  mocks.route.mockReturnValue({ kind: 'resolved', route: { runtimeEnvironmentId: null } })
  mocks.local.mockReturnValue({ tabId: 'new-terminal' })
})
describe('canvas agent launch', () => {
  it('uses the existing launcher and keeps the canvas selected', async () => {
    await expect(launchCanvasAgent(tab, 'codex')).resolves.toBe('new-terminal')
    expect(mocks.local).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'folder:one',
      groupId: 'group',
      viewMode: 'terminal'
    })
    expect(mocks.activate).toHaveBeenCalledWith('canvas')
  })
  it('launches on the owning peer without stealing workspace focus', async () => {
    mocks.host = 'runtime:peer'
    mocks.route.mockReturnValue({ kind: 'resolved', route: { runtimeEnvironmentId: 'peer' } })
    mocks.remote.mockResolvedValue({ outcome: { status: 'created' }, hostTabId: 'host-tab' })
    await expect(
      launchCanvasAgent({ ...tab, executionHostId: 'runtime:peer' }, 'codex')
    ).resolves.toBe('web-terminal-host-tab')
    expect(mocks.remote).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'peer', activate: false, selectWorktree: false })
    )
    expect(mocks.local).not.toHaveBeenCalled()
  })
  it('does not substitute local execution for a failed remote create or changed host', async () => {
    mocks.host = 'runtime:peer'
    await expect(launchCanvasAgent(tab, 'codex')).rejects.toThrow('Select this canvas workspace')
    mocks.route.mockReturnValue({ kind: 'resolved', route: { runtimeEnvironmentId: 'peer' } })
    mocks.remote.mockResolvedValue({ outcome: { status: 'failed', message: 'unverifiable' } })
    await expect(
      launchCanvasAgent({ ...tab, executionHostId: 'runtime:peer' }, 'codex')
    ).rejects.toThrow('unverifiable')
    expect(mocks.local).not.toHaveBeenCalled()
  })
})
