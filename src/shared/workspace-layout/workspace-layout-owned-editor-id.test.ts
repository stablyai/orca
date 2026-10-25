// Owned editor IDs must retain facts main associates with the file for floating, contested and moved files.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { applyLayoutCommand } from './workspace-layout-commands'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { testContext } from './workspace-layout-command.test-fixture'
import { addWorkspace, emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'
import { tabExecutionHostId } from './workspace-layout-tab-host'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
})

const onDisk = (session: WorkspaceSessionState): unknown => JSON.parse(JSON.stringify(session))

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
  it.each([
    ['a floating file', FLOATING_TERMINAL_WORKTREE_ID],
    ['a git workspace file', GIT_KEY]
  ])('%s keeps its preview through load, save and load', (_name, key) => {
    const { session: stored } = previewUnderOwnedId(key, '/Users/dev/notes/todo.md')

    const once = load(stored)
    expect(once.changes).toEqual([])
    expect(once.layout.workspaces[key]!.tabs[0]).toMatchObject({ isPreview: true })
    const saved = saveWorkspaceLayout(once)
    expect(onDisk(saved)).toEqual(onDisk(stored))

    const twice = load(saved)
    expect(twice.layout.workspaces[key]!.tabs[0]).toMatchObject({ isPreview: true })
    expect(onDisk(saveWorkspaceLayout(twice))).toEqual(onDisk(stored))
  })

  it('keeps it as the active file', () => {
    const { session: stored, fileId } = previewUnderOwnedId(GIT_KEY, '/Users/dev/orca/README.md')
    stored.activeFileIdByWorktree = { [GIT_KEY]: fileId }
    stored.activeTabTypeByWorktree = { [GIT_KEY]: 'editor' }

    const saved = saveWorkspaceLayout(load(stored))

    expect(saved.activeFileIdByWorktree?.[GIT_KEY]).toBe(fileId)
  })

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

  it('match by path alone when the switch is off, as a headless host saves today', () => {
    mocks.layoutOwnerIsMain = false
    const { session } = previewUnderOwnedId(GIT_KEY, '/Users/dev/orca/README.md')

    const saved = saveWorkspaceLayout(load(session))

    expect(saved.openFilesByWorktree?.[GIT_KEY]?.[0]?.isPreview).toBeUndefined()
  })
})
