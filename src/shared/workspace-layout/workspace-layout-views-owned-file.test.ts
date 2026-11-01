// Owned file IDs must survive view reads/pruning just like bare paths for floating and contested files.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import { emptyModel, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayout } from './workspace-layout-model'
import { pruneViewRecord } from './workspace-layout-view-prune'
import {
  emptyLayoutViewRecord,
  resolveWorkspaceSelection,
  type LayoutViewRecord
} from './workspace-layout-views'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const PATH = '/srv/app/README.md'
const OWNED = ownedEditorFileId(PATH, WS, 'env-1')

function workspace(): WorkspaceLayout {
  return {
    worktreeId: WS,
    groups: [{ id: 'g1', tabOrder: ['t1'] }],
    tabs: [
      { id: 't1', entityId: OWNED, kind: 'editor', createdAt: 1, customTitle: null, color: null }
    ],
    editorFiles: [
      {
        filePath: PATH,
        relativePath: 'README.md',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1'
      }
    ]
  }
}

const activeOn = (id: string): LayoutViewRecord => ({
  ...emptyLayoutViewRecord(),
  activeFileIdByWorktree: { [WS]: id }
})

describe('an owned-id active file, layout-owner build', () => {
  it('reads back as the active file', () => {
    expect(resolveWorkspaceSelection(activeOn(OWNED), WS, workspace()).activeFileId).toBe(OWNED)
  })

  it('stays through a prune', () => {
    const pruned = pruneViewRecord(activeOn(OWNED), {
      ...emptyModel(),
      workspaces: { [WS]: workspace() }
    })

    expect(pruned.activeFileIdByWorktree?.[WS]).toBe(OWNED)
  })

  it('falls back when no record holds it', () => {
    const gone = ownedEditorFileId(PATH, WS, 'env-2')

    expect(resolveWorkspaceSelection(activeOn(gone), WS, workspace()).activeFileId).toBeNull()
  })
})
