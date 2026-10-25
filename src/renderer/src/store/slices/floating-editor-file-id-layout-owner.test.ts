import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { buildHydratedEditorSessionState } from './editor/actions/hydrated-editor-session-state'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { asLoaded } from '../../../../shared/workspace-layout/workspace-layout-command.test-fixture'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: LayoutCommand }) => ({
      ok: true,
      result: {}
    })
  )
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))

const WT = FLOATING_TERMINAL_WORKTREE_ID

function openFloatingFile(): string {
  const store = createEditorTabsStore()
  store.setState({
    activeWorktreeId: WT,
    groupsByWorktree: { [WT]: [{ id: 'g1', worktreeId: WT, activeTabId: null, tabOrder: [] }] },
    activeGroupIdByWorktree: { [WT]: 'g1' },
    unifiedTabsByWorktree: { [WT]: [] }
  })
  return store.getState().openFile(
    {
      filePath: '/notes/a.md',
      relativePath: 'a.md',
      worktreeId: WT,
      language: 'md',
      mode: 'edit'
    },
    { preview: false }
  )
}

beforeEach(() => {
  mocks.callRuntimeRpc.mockClear()
})

describe('floating workspace editor file ids', () => {
  it('opens a floating file under the id restoring main’s copy gives it, with the switch on', () => {
    mocks.layoutOwnerIsMain = true
    const fileId = openFloatingFile()

    let main: WorkspaceLayoutModel = {
      hostId: LOCAL_EXECUTION_HOST_ID,
      workspaces: { [WT]: { worktreeId: WT, tabs: [], groups: [{ id: 'g1', tabOrder: [] }] } },
      records: {},
      legacy: { terminalRowOwners: {} }
    }
    for (const call of mocks.callRuntimeRpc.mock.calls) {
      const applied = applyLayoutCommand(main, call[2].command, {
        mintId: () => 'main-id',
        mintLeafId: () => 'leaf-id',
        now: () => 1
      })
      if (!applied.ok) {
        throw new Error(applied.code)
      }
      main = applied.model
    }
    expect(main.workspaces[WT]!.tabs.map((tab) => tab.entityId)).toEqual([fileId])

    // Every frame restores main's copy this way; the id must come back unchanged.
    const saved = saveWorkspaceLayout(asLoaded(main))
    const restored = buildHydratedEditorSessionState(saved, new Set([WT]), null)
    expect(restored.state.openFiles.map((file) => file.id)).toEqual([fileId])
    expect(saved.unifiedTabs?.[WT]?.map((tab) => tab.entityId)).toEqual([fileId])
  })

  it('keeps the bare path id with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    expect(openFloatingFile()).toBe('/notes/a.md')
  })
})
