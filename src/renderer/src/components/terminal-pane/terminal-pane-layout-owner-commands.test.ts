import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { equalizeTerminalPanes } from './terminal-pane-layout-owner-commands'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  endLayoutFramePositions
} from '@/runtime/layout-frame-position'
import { provideServerLayoutApplyRoutes } from '@/runtime/server-layout-apply-routes'

const mocks = vi.hoisted(
  (): {
    callRuntimeRpc: ReturnType<typeof vi.fn>
    ownerEnvironmentId: string | null
    layoutOwnerIsMain: boolean
  } => ({
    callRuntimeRpc: vi.fn(),
    ownerEnvironmentId: null,
    layoutOwnerIsMain: false
  })
)

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.ownerEnvironmentId
}))

describe('equalizeTerminalPanes', () => {
  beforeEach(() => {
    mocks.callRuntimeRpc.mockReset()
    mocks.ownerEnvironmentId = null
    mocks.layoutOwnerIsMain = false
    _resetLayoutFramePositionForTests()
  })

  function manager() {
    const equalizePaneSizes = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: equalize calls only equalizePaneSizes.
    return { equalizePaneSizes } as unknown as PaneManager & {
      equalizePaneSizes: typeof equalizePaneSizes
    }
  }

  it('a window-owned build equalizes at once, without asking main', () => {
    const current = manager()
    const then = vi.fn()

    equalizeTerminalPanes(
      { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
      then
    )

    expect(current.equalizePaneSizes).toHaveBeenCalledOnce()
    expect(then).toHaveBeenCalledWith(current)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('a layout-owner build leaves the sizes to main’s frame, then focuses', async () => {
    mocks.layoutOwnerIsMain = true
    beginLayoutFramePositions()
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const current = manager()
    const then = vi.fn()

    equalizeTerminalPanes(
      { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
      then
    )

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'layout.apply', {
      command: { type: 'equalizePanes', tabId: 'tab-1', workspace: 'worktree-1' }
    })
    await vi.waitFor(() => expect(then).toHaveBeenCalledWith(current))
    expect(current.equalizePaneSizes).not.toHaveBeenCalled()
  })

  it('a layout-owner build equalizes itself when no frame is coming', async () => {
    mocks.layoutOwnerIsMain = true
    beginLayoutFramePositions()
    endLayoutFramePositions()
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const current = manager()
    const then = vi.fn()

    equalizeTerminalPanes(
      { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
      then
    )

    await vi.waitFor(() => expect(then).toHaveBeenCalledWith(current))
    expect(current.equalizePaneSizes).toHaveBeenCalledOnce()
  })

  it('leaves a paired server’s panes to that server’s frames, whatever this window’s stream does', async () => {
    mocks.layoutOwnerIsMain = true
    mocks.ownerEnvironmentId = 'env-1'
    // This window's own stream is down; the server's frames draw the workspace.
    const stop = provideServerLayoutApplyRoutes('env-1', () => ({
      environmentId: 'env-1',
      serverTabId: () => 'server-tab-1',
      desktopTabId: (id) => id,
      redraw: vi.fn()
    }))
    mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
    const current = manager()
    const then = vi.fn()
    try {
      equalizeTerminalPanes(
        { worktreeId: 'worktree-1', tabId: 'tab-1', getManager: () => current },
        then
      )

      expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'env-1' },
        'layout.apply',
        { command: { type: 'equalizePanes', tabId: 'server-tab-1', workspace: 'worktree-1' } }
      )
      await vi.waitFor(() => expect(then).toHaveBeenCalledWith(current))
      expect(current.equalizePaneSizes).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})
