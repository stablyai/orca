// Owned editor IDs must retain facts main associates with the file for floating, contested and moved files.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../execution-host'
import { ownedEditorFileId } from '../../workspace-session/workspace-session-pane-ownership'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import { applyLayoutCommand } from '../workspace-layout-commands'
import { loadWorkspaceLayout } from '../persistence/workspace-layout-load'
import '../persistence/workspace-layout-save'
import { testContext } from '../commands/workspace-layout-command.test-fixture'
import {
  addWorkspace,
  emptySession,
  GIT_KEY
} from '../persistence/workspace-layout-session.test-fixture'
import { tabExecutionHostId } from './workspace-layout-tab-host'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

function load(session: WorkspaceSessionState) {
  let id = 0
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, {
    mintId: () => `minted-${++id}`,
    mintLeafId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`
  })
}

/** One preview editor tab under its owned id, saved as the window saves it. */
function previewUnderOwnedId(
  key: string,
  filePath: string,
  runtimeEnvironmentId?: string
): { session: WorkspaceSessionState; fileId: string } {
  const fileId = ownedEditorFileId(filePath, key, runtimeEnvironmentId)
  const session = addWorkspace(emptySession(), key, [
    {
      id: 'group-1',
      tabs: [{ id: fileId, kind: 'editor', entry: { isPreview: true } }]
    }
  ])
  session.openFilesByWorktree = {
    [key]: [
      {
        filePath,
        relativePath: filePath.split('/').at(-1)!,
        worktreeId: key,
        language: 'markdown',
        isPreview: true,
        ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
      }
    ]
  }
  return { session, fileId }
}

describe('editor tabs under an owned id, layout-owner build', () => {
  it('a stored disagreement still demotes the tab, as for a bare id', () => {
    const { session } = previewUnderOwnedId(GIT_KEY, '/Users/dev/orca/README.md')
    delete session.openFilesByWorktree?.[GIT_KEY]?.[0]?.isPreview

    const loaded = load(session)

    expect(loaded.layout.workspaces[GIT_KEY]!.tabs[0]!.isPreview).toBeUndefined()
  })

  it("names its file's host and drops its file's record when its last tab closes", () => {
    const filePath = '/srv/app/README.md'
    const { session, fileId } = previewUnderOwnedId(GIT_KEY, filePath, 'env-1')
    const { layout } = load(session)
    const workspace = layout.workspaces[GIT_KEY]!

    expect(tabExecutionHostId(workspace.tabs[0]!, workspace, LOCAL_EXECUTION_HOST_ID)).toBe(
      'runtime:env-1'
    )
    const closed = applyLayoutCommand(
      layout,
      { type: 'closeTabs', workspace: GIT_KEY, tabIds: [fileId] },
      testContext()
    )
    expect(closed.ok && closed.model.workspaces[GIT_KEY]!.editorFiles).toEqual([])
  })
})
