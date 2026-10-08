import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { makeWorktree } from '../components/worktree-jump-palette-test-fixtures'

const WORKTREE = 'repo-1::/srv/repo'
const serverWorktrees = {
  'repo-1': [makeWorktree(WORKTREE, 'repo', { path: '/srv/repo', hostId: 'runtime:env-1' })]
}
const LEAF = '11111111-1111-4111-8111-111111111111'

function tab(id: string, contentType: Tab['contentType'], entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function group(tabOrder: string[]): TabGroup {
  return { id: 'group-1', worktreeId: WORKTREE, activeTabId: tabOrder[0] ?? null, tabOrder }
}

function file(id: string): AppState['openFiles'][number] {
  return {
    id,
    filePath: id,
    relativePath: id.slice('/srv/repo/'.length),
    worktreeId: WORKTREE,
    language: 'typescript',
    mode: 'edit',
    isDirty: false
  }
}

/** A server workspace as the desktop shows it: its own editor tab between the server's tabs. */
function serverWorkspaceState(): AppState {
  return makeState({
    worktreesByRepo: serverWorktrees,
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    groupsByWorktree: {
      [WORKTREE]: [group(['unified-term', 'unified-editor', 'unified-browser'])]
    },
    unifiedTabsByWorktree: {
      [WORKTREE]: [
        tab('unified-term', 'terminal', 'web-terminal-host-tab-1'),
        tab('unified-editor', 'editor', '/srv/repo/a.ts'),
        tab('unified-browser', 'browser', 'host-page-1')
      ]
    },
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: 'web-terminal-host-tab-1',
          worktreeId: WORKTREE,
          ptyId: 'remote:env-1@@terminal-1',
          title: 'Terminal',
          defaultTitle: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'web-terminal-host-tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'remote:env-1@@terminal-1' }
      }
    },
    openFiles: [file('/srv/repo/a.ts')]
  })
}

describe('desktop tab order in the mobile publication', () => {
  it("names the server's tabs by their server ids around the desktop's own", () => {
    const snapshot = buildMobileSessionTabSnapshots(serverWorkspaceState())[0]

    expect(snapshot?.tabGroups).toEqual([
      expect.objectContaining({
        tabOrder: ['unified-editor'],
        desktopTabOrder: ['host-tab-1', 'unified-editor', 'host-page-1']
      })
    ])
  })

  it('sends it for a server workspace even when the desktop holds every tab', () => {
    const state = makeState({
      worktreesByRepo: serverWorktrees,
      activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
      groupsByWorktree: { [WORKTREE]: [group(['unified-editor'])] },
      unifiedTabsByWorktree: { [WORKTREE]: [tab('unified-editor', 'editor', '/srv/repo/a.ts')] },
      openFiles: [file('/srv/repo/a.ts')]
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabGroups?.[0]).toMatchObject({
      desktopTabOrder: ['unified-editor']
    })
  })

  it("leaves it out for the desktop's own workspaces, whose strip it publishes whole", () => {
    const state = { ...serverWorkspaceState(), worktreesByRepo: {} }

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabGroups?.[0]).not.toHaveProperty(
      'desktopTabOrder'
    )
  })
})
