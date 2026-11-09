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
})
