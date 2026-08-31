import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import { withoutStagedBrowserTabs } from './workspace-session-staged-browser-tabs'

const WT = 'wt-1'
const GROUP_ID = 'group-1'

function browserRow(suffix: string): { workspaceId: string; pageId: string; tabId: string } {
  return {
    workspaceId: `workspace-${suffix}`,
    pageId: `page-${suffix}`,
    tabId: `tab-${suffix}`
  }
}

const ADOPTED = browserRow('adopted')
const STAGED = browserRow('staged')

function createSnapshot(): Pick<
  WorkspaceSessionSnapshot,
  | 'activeBrowserTabIdByWorktree'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
> {
  return {
    activeBrowserTabIdByWorktree: { [WT]: STAGED.workspaceId },
    browserTabsByWorktree: {
      [WT]: [ADOPTED, STAGED].map(
        (row) =>
          ({
            id: row.workspaceId,
            worktreeId: WT,
            activePageId: row.pageId,
            pageIds: [row.pageId]
          }) as never
      )
    },
    browserPagesByWorkspace: Object.fromEntries(
      [ADOPTED, STAGED].map((row) => [
        row.workspaceId,
        [{ id: row.pageId, workspaceId: row.workspaceId, worktreeId: WT } as never]
      ])
    ),
    remoteBrowserPageHandlesByPageId: {
      [ADOPTED.pageId]: { environmentId: 'env-1', remotePageId: 'remote-adopted' },
      [STAGED.pageId]: { environmentId: 'env-1', remotePageId: 'remote-staged', staged: true }
    },
    unifiedTabsByWorktree: {
      [WT]: [ADOPTED, STAGED].map(
        (row) =>
          ({
            id: row.tabId,
            entityId: row.workspaceId,
            groupId: GROUP_ID,
            worktreeId: WT,
            contentType: 'browser'
          }) as never
      )
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP_ID,
          worktreeId: WT,
          activeTabId: STAGED.tabId,
          tabOrder: [ADOPTED.tabId, STAGED.tabId]
        } as never
      ]
    }
  }
}

describe('withoutStagedBrowserTabs', () => {
  it('drops a staged browser tab from every slice that would persist it', () => {
    const filtered = withoutStagedBrowserTabs(createSnapshot())

    expect(filtered.browserTabsByWorktree[WT]?.map((workspace) => workspace.id)).toEqual([
      ADOPTED.workspaceId
    ])
    expect(filtered.browserPagesByWorkspace).not.toHaveProperty(STAGED.workspaceId)
    expect(filtered.unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([ADOPTED.tabId])
    // A dangling active id would restore a workspace that is no longer there.
    expect(filtered.activeBrowserTabIdByWorktree[WT]).toBeNull()
  })

  it('keeps adopted browser tabs and returns the snapshot untouched when nothing is staged', () => {
    const snapshot = createSnapshot()
    delete snapshot.remoteBrowserPageHandlesByPageId[STAGED.pageId]

    expect(withoutStagedBrowserTabs(snapshot)).toBe(snapshot)
  })
})
