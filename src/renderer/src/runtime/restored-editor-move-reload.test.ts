// Reload main’s saved restored-editor move (F42/Q5); frame-drawn tab and file must exist only in destination workspace. Main Store counterpart: main/runtime/restored-editor-move-restart.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { testContext } from '../../../shared/workspace-layout/workspace-layout-command.test-fixture'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { localDesktopSession } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  FOLDER_KEY,
  GIT_KEY
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { bootWindowFromPartitions } from '../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../store/slices/store-session-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { endLayoutFramePositions } from './layout-frame-position'
import {
  loadMainLayoutModel,
  mainLayoutFrameSender,
  publishedLayoutsOf
} from './main-loaded-layout-frames.test-fixture'
import { installLayoutFrameApplyCheck } from './workspace-layout-frame-apply-check.test-fixture'
import { openWorkspaceLayoutFrameSync } from './workspace-layout-frame-sync'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)
vi.mock('./runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

createStoreSessionMockApi()

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const TAB_ID = 'editor:src/app.ts'
const FILE_PATH = '/Users/dev/orca/src/app.ts'
const MOVED_ID = ownedEditorFileId(FILE_PATH, FOLDER_KEY, null)

/** The session main saves after applying the window's re-own of the restored tab to the folder. */
function sessionSavedAfterMove(): WorkspaceSessionState {
  const loaded = loadWorkspaceLayoutWithoutReport(
    'local',
    localDesktopSession(),
    nameBasedLoadContext()
  )
  const moved = applyLayoutCommand(
    loaded.layout,
    {
      type: 'moveTabToWorkspace',
      workspace: GIT_KEY,
      toWorkspace: FOLDER_KEY,
      tabs: [{ tabId: TAB_ID, newTabId: TAB_ID, newEntityId: MOVED_ID }],
      groupId: 'group-folder',
      file: { filePath: FILE_PATH, relativePath: 'app.ts', language: 'typescript' }
    },
    testContext()
  )
  if (!moved.ok) {
    throw new Error(`main refused the move: ${moved.code}`)
  }
  return saveWorkspaceLayout({ ...loaded, layout: moved.model })
}

let check: ReturnType<typeof installLayoutFrameApplyCheck>
beforeEach(() => {
  check = installLayoutFrameApplyCheck()
})
afterEach(() => {
  endLayoutFramePositions()
  check.uninstall()
  expect(check.failures).toEqual([])
})

describe('a window reloaded after main saved a restored-editor move', () => {
  it('shows the tab and its open file in the new workspace, once', async () => {
    const saved = sessionSavedAfterMove()
    const store = createTestStore()
    await bootWindowFromPartitions(store, [{ hostId: 'local', session: saved }])
    const sync = openWorkspaceLayoutFrameSync(store)
    stream.onFrame!(
      mainLayoutFrameSender().snapshot(publishedLayoutsOf(loadMainLayoutModel('local', saved)))
    )
    sync.start()
    await settle()

    const state = store.getState()
    const editorTabs = Object.entries(state.unifiedTabsByWorktree).flatMap(([key, tabs]) =>
      tabs.filter((tab) => tab.contentType === 'editor').map((tab) => ({ key, tab }))
    )
    expect(editorTabs).toEqual([
      { key: FOLDER_KEY, tab: expect.objectContaining({ id: TAB_ID, entityId: MOVED_ID }) }
    ])
    expect(
      state.groupsByWorktree[FOLDER_KEY]?.find((group) => group.id === 'group-folder')?.tabOrder
    ).toContain(TAB_ID)
    expect(state.groupsByWorktree[GIT_KEY]?.some((g) => g.tabOrder.includes(TAB_ID))).toBe(false)
    // The tab's file is the window's one open file for that path, under the tab's id.
    expect(
      state.openFiles
        .filter((file) => file.filePath === FILE_PATH)
        .map(({ id, worktreeId, relativePath }) => ({ id, worktreeId, relativePath }))
    ).toEqual([{ id: MOVED_ID, worktreeId: FOLDER_KEY, relativePath: 'app.ts' }])
    sync.close()
  })
})
