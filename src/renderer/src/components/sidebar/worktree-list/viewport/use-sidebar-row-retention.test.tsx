// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { buildSidebarGeometry } from '../listing/sidebar-geometry-slots'
import { geometryFolderRow } from '../rows/lineage-virtualization-test-fixtures'
import { useSidebarRowRetention, type SidebarRetentionInputs } from './use-sidebar-row-retention'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { renamingWorktreeId: null }) => unknown) =>
    selector({ renamingWorktreeId: null })
}))
globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('sidebar folder retention', () => {
  it('retains active and pending folder workspace keys and keeps landing after interaction', async () => {
    const folder = geometryFolderRow()
    const model = buildSidebarGeometry([folder])
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let targets: { index: number; landing: boolean }[] = []
    const args: SidebarRetentionInputs = {
      model,
      defaultHostId: 'local',
      activeWorktreeId: folderWorkspaceKey(folder.folderWorkspace.id),
      activeWorkspaceExecutionHostId: 'local',
      pendingRevealWorktree: null,
      pendingRevealSidebarRow: null,
      draggingWorktreeId: null
    }
    function Probe() {
      const retention = useSidebarRowRetention(args)
      targets = retention.targets
      return (
        <div onContextMenuCapture={retention.retainInteraction}>
          <div data-sidebar-geometry-node={model.nodes[0]!.key}>Folder</div>
        </div>
      )
    }
    try {
      await act(async () => root.render(<Probe />))
      expect(targets).toEqual([{ index: 0, landing: false }])
      await act(async () =>
        container
          .querySelector('[data-sidebar-geometry-node]')!
          .dispatchEvent(new Event('contextmenu', { bubbles: true }))
      )
      args.pendingRevealWorktree = {
        worktreeId: folderWorkspaceKey(folder.folderWorkspace.id),
        executionHostId: 'local',
        behavior: 'auto',
        highlight: false,
        beginRename: false
      }
      await act(async () => root.render(<Probe />))
      expect(targets).toEqual([{ index: 0, landing: true }])
      args.pendingRevealWorktree = {
        ...args.pendingRevealWorktree,
        executionHostId: 'ssh:elsewhere'
      }
      args.activeWorktreeId = null
      await act(async () => root.render(<Probe />))
      expect(targets).toEqual([{ index: 0, landing: false }])
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
