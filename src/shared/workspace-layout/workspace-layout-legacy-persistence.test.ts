import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { emptyLayoutBeside } from './workspace-layout-model-rules'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { FOLDER_KEY, GIT_KEY, leaf } from './workspace-layout-session.test-fixture'

function loaded(): WorkspaceLayoutModel {
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, localDesktopSession(), {
    mintId: () => 'minted',
    mintLeafId: () => leaf(9)
  }).layout
}

function edit(
  before: WorkspaceLayoutModel,
  key: string,
  change: (workspace: WorkspaceLayout) => WorkspaceLayout
): WorkspaceLayoutModel {
  return { ...before, workspaces: { ...before.workspaces, [key]: change(before.workspaces[key]!) } }
}

const withoutTab = (tabId: string) => (workspace: WorkspaceLayout) => ({
  ...workspace,
  tabs: workspace.tabs.filter((tab) => tab.id !== tabId),
  groups: workspace.groups
    .map((group) => ({ ...group, tabOrder: group.tabOrder.filter((id) => id !== tabId) }))
    .filter((group) => group.tabOrder.length > 0)
})

describe('updateLegacyPersistence: the one update after each apply', () => {
  it('advances a repo once when its terminal panes change, however many', () => {
    const before = loaded()
    const after = edit(
      edit(before, GIT_KEY, withoutTab('tab-shell')),
      GIT_KEY,
      withoutTab('tab-agent')
    )
    const next = updateLegacyPersistence(before, after)
    expect(next.legacy.topologyRevisionByRepoId).toEqual({ 'repo-1': 8 })
  })

  it('leaves the revision alone for a change that keeps every pane', () => {
    const before = loaded()
    const after = edit(before, GIT_KEY, (workspace) => ({
      ...workspace,
      groups: workspace.groups.map((group) => ({ ...group, tabOrder: group.tabOrder.toReversed() }))
    }))
    expect(updateLegacyPersistence(before, after).legacy).toEqual(before.legacy)
  })

  it('advances for a retirement even when the pane was already gone', () => {
    const before = loaded()
    expect(
      updateLegacyPersistence(before, before, [GIT_KEY]).legacy.topologyRevisionByRepoId
    ).toEqual({ 'repo-1': 8 })
  })

  it('keeps a workspace the owner of its rows after its last terminal closes', () => {
    const before = loaded()
    const after = updateLegacyPersistence(before, edit(before, FOLDER_KEY, withoutTab('tab-notes')))
    expect(after.legacy.terminalRowOwners[FOLDER_KEY]).toBe(true)
    const saved = saveWorkspaceLayout({ ...emptyLayoutBeside(), layout: after })
    expect(saved.tabsByWorktree[FOLDER_KEY]).toEqual([])
  })

  it('makes a workspace the owner once it holds a terminal, and drops a removed one', () => {
    const before = loaded()
    delete before.legacy.terminalRowOwners[FOLDER_KEY]
    const touched = edit(before, FOLDER_KEY, (workspace) => ({ ...workspace }))
    expect(updateLegacyPersistence(before, touched).legacy.terminalRowOwners[FOLDER_KEY]).toBe(true)
    const removed = { ...before, workspaces: { [GIT_KEY]: before.workspaces[GIT_KEY]! } }
    const next = updateLegacyPersistence(loaded(), removed)
    expect(Object.keys(next.legacy.terminalRowOwners)).toEqual([GIT_KEY])
    // Panes leaving with their workspace advance nothing.
    expect(next.legacy.topologyRevisionByRepoId).toEqual({ 'repo-1': 7 })
  })

  it('advances nothing when a workspace is renamed with its panes', () => {
    const before = loaded()
    const { [FOLDER_KEY]: folder, ...rest } = before.workspaces
    const renamed = { ...before, workspaces: { ...rest, 'folder:renamed': folder! } }
    expect(updateLegacyPersistence(before, renamed).legacy.topologyRevisionByRepoId).toEqual({
      'repo-1': 7
    })
  })
})
