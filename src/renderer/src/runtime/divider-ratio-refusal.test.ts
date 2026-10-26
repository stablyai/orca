// A stale divider path is refused by main; the window restores main’s unchanged ratios when its tab hold ends.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { useAppStore } from '@/store'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { GIT_KEY } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { setGroupRatioThroughLayoutOwner } from '../components/tab-group/tab-group-layout-owner-commands'
import { layoutOwnerPaneGestures } from '../components/terminal-pane/terminal-pane-layout-owner-gestures'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { endLayoutFramePositions } from './layout-frame-position'
import { provideLayoutFrameTerminalPanes } from './layout-frame-terminal-panes'
import { layoutApplyTestTransport } from './layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from './main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// The test opens its own stream: boot's document-long one would outlive the test's transport.
vi.mock('./workspace-layout-frame-sync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showStartupLayoutFrames: () => {}
}))
// Main's answer to the window's layout commands and its frames, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const settle = async (): Promise<void> => {
  await layoutApplyTestTransport.settle()
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

let close = (): void => {}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  layoutApplyTestTransport.reset()
  const session = localDesktopSession()
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  provideLayoutFrameTerminalPanes(sync)
  sync.start()
  await settle()
  close = () => sync.close()
})

afterEach(() => {
  close()
  endLayoutFramePositions()
  vi.restoreAllMocks()
})

/** Main's workspace as another client left it, with no frame sent yet. */
function mainChanges(change: (workspace: WorkspaceLayoutModel['workspaces'][string]) => void) {
  const model = structuredClone(layoutApplyTestTransport.mainModel!)
  change(model.workspaces[GIT_KEY]!)
  layoutApplyTestTransport.useMainModel(model)
  return model
}

describe('a divider drag on a split main no longer holds at its path', () => {
  it('is refused for panes: main moves nothing and the window snaps back to main’s ratios', async () => {
    const shown = useAppStore.getState().terminalLayoutsByTabId['tab-shell']!
    const root = shown.root!
    if (root.type !== 'split') {
      throw new Error('expected a split tab')
    }
    // Another client swapped the tab's panes: the root split is now another one.
    const changed = mainChanges((workspace) => {
      const tab = workspace.tabs.find((entry) => entry.id === 'tab-shell')!
      if (tab.kind === 'terminal' && tab.panes.root?.type === 'split') {
        tab.panes = {
          ...tab.panes,
          root: { ...tab.panes.root, first: tab.panes.root.second, second: tab.panes.root.first }
        }
      }
    })
    const mainBefore = structuredClone(changed.workspaces[GIT_KEY])
    // The window's drag writes its tree, as the pane's persist does, then ends.
    useAppStore.getState().setTabLayout('tab-shell', { ...shown, root: { ...root, ratio: 0.3 } })
    layoutOwnerPaneGestures({
      worktreeId: GIT_KEY,
      tabId: 'tab-shell',
      managerRef: { current: null },
      shouldPersistLayout: () => true
    }).onDividerRatiosCommitted?.()
    await settle()

    expect(layoutApplyTestTransport.sentOfType('setPaneRatios')).toEqual([
      expect.objectContaining({ ratios: [expect.objectContaining({ path: '', ratio: 0.3 })] })
    ])
    expect(layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]).toEqual(mainBefore)
    // The window shows main's last frame again: the drag snapped back.
    expect(useAppStore.getState().terminalLayoutsByTabId['tab-shell']!.root).toEqual(root)
  })

  it('is refused for groups: main moves nothing and the window snaps back to main’s ratios', async () => {
    const shown = useAppStore.getState().layoutByWorktree[GIT_KEY]
    if (shown?.type !== 'split') {
      throw new Error('expected two groups')
    }
    const changed = mainChanges((workspace) => {
      const layout = workspace.groupLayout
      if (layout?.type === 'split') {
        workspace.groupLayout = { ...layout, first: layout.second, second: layout.first }
      }
    })
    const mainBefore = structuredClone(changed.workspaces[GIT_KEY])

    setGroupRatioThroughLayoutOwner(GIT_KEY, '', 0.3)
    expect(useAppStore.getState().layoutByWorktree[GIT_KEY]).toMatchObject({ ratio: 0.3 })
    await settle()

    expect(layoutApplyTestTransport.sentOfType('setGroupRatios')).toHaveLength(1)
    expect(layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]).toEqual(mainBefore)
    expect(useAppStore.getState().layoutByWorktree[GIT_KEY]).toEqual(shown)
  })
})
