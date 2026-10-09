import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { checkWorkspaceLayoutModelRules, emptyLayoutBeside } from './workspace-layout-model-rules'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { GIT_KEY, leaf } from './workspace-layout-session.test-fixture'
import { checkWorkspaceLayoutRules } from './workspace-layout-rules'

function model(): WorkspaceLayoutModel {
  let next = 0
  return loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, localDesktopSession(), {
    mintId: () => `minted-${++next}`,
    mintLeafId: () => leaf(9)
  }).layout
}

function withGitWorkspace(edit: (workspace: WorkspaceLayout) => void): WorkspaceLayoutModel {
  const broken = model()
  edit(broken.workspaces[GIT_KEY]!)
  return broken
}

const rules = (layout: WorkspaceLayoutModel) =>
  checkWorkspaceLayoutModelRules([layout]).map((violation) => violation.rule)

describe('checkWorkspaceLayoutModelRules: the model itself, not what it saves to', () => {
  it('passes a loaded desktop partition', () => {
    expect(rules(model())).toEqual([])
  })

  it('flags a content tab no group holds, which the Serializer would silently drop', () => {
    const broken = withGitWorkspace((workspace) => {
      workspace.groups[1]!.tabOrder = workspace.groups[1]!.tabOrder.filter(
        (tabId) => tabId !== 'browser-1'
      )
    })
    expect(rules(broken)).toEqual(['tab_without_group'])
    // On disk the tab is simply gone, so the disk rules alone cannot see it.
    const saved = saveWorkspaceLayout({ ...emptyLayoutBeside(), layout: broken })
    expect(
      checkWorkspaceLayoutRules([{ hostId: LOCAL_EXECUTION_HOST_ID, session: saved }])
    ).toEqual([])
  })

  it('flags a group tree that names a group the workspace lacks or misses one it has', () => {
    const missing = withGitWorkspace((workspace) => {
      workspace.groupLayout = { type: 'leaf', groupId: 'group-a' }
    })
    expect(rules(missing)).toEqual(['group_tree_mismatch'])
    const stray = withGitWorkspace((workspace) => {
      workspace.groupLayout = {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-a' },
        second: { type: 'leaf', groupId: 'group-gone' }
      }
    })
    expect(rules(stray)).toEqual(['group_tree_mismatch'])
  })

  it('flags an empty group, a tab in two groups and pane data with no pane', () => {
    const broken = withGitWorkspace((workspace) => {
      workspace.groups[1]!.tabOrder.push('tab-shell')
      workspace.groups.push({ id: 'group-c', tabOrder: [] })
      workspace.leaves = { ...workspace.leaves, [leaf(8)]: { title: 'gone' } }
    })
    expect(rules(broken)).toEqual(
      expect.arrayContaining([
        'group_empty',
        'tab_in_two_groups',
        'group_tree_mismatch',
        'leaf_without_pane'
      ])
    )
  })

  it('flags one leaf id in two tabs, since pane data is keyed by leaf alone', () => {
    const broken = withGitWorkspace((workspace) => {
      const unbound = workspace.tabs.find((tab) => tab.id === 'tab-unbound')!
      if (unbound.kind === 'terminal') {
        unbound.panes.root = { type: 'leaf', leafId: leaf(3) }
      }
    })
    expect(rules(broken)).toEqual(['pane_in_two_tabs'])
  })
})
