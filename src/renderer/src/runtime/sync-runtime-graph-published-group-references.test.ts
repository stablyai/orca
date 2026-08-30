import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import {
  collectLayoutGroupIds,
  danglingGroupRefs,
  danglingTabRefs,
  unplacedPublishedGroupIds
} from './sync-runtime-graph-published-reference-invariants'
import type { AppState } from '../store/types'

// The invariant these share: the mobile snapshot may not publish an id that names something it did
// not publish. Held-back tabs already drag their group out of `tabGroups`; these pin that the
// snapshot's own `activeGroupId` and `tabGroupLayout` follow the group out rather than pointing at
// a group the phone was never sent, and that every tab a group names is one the client can resolve.

describe('buildMobileSessionTabSnapshots published group references', () => {
  const mountedLeafId = '22222222-2222-4222-8222-222222222222'

  // Why groups get their own fixture: 'omits a browser tab located by a workspace document from
  // mobile snapshots' (in sync-runtime-graph-editor-diff-tabs.test.ts) drives the same document
  // through the legacy nav order, where the per-tab guard is the only thing holding it back. With
  // groups the projection runs first and publishes group metadata of its own, so a document reaching
  // it leaves a group whose tabOrder and activeTabId name a tab the phone is never sent.
  it('keeps a workspace document out of published tab groups as well as the tab list', () => {
    const docWorkspaceId = 'browser-doc'
    const urlWorkspaceId = 'browser-url'
    const rightLeafId = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      // The document's group is the active one: if it survived anywhere, this is where it shows.
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'unified-doc',
            tabOrder: ['unified-doc'],
            recentTabIds: ['unified-doc']
          },
          {
            id: 'group-right',
            activeTabId: 'unified-url',
            tabOrder: ['unified-url', 'term-right'],
            recentTabIds: ['unified-url', 'term-right']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-doc',
            groupId: 'group-left',
            contentType: 'browser',
            entityId: docWorkspaceId,
            title: 'report.html'
          },
          {
            id: 'unified-url',
            groupId: 'group-right',
            contentType: 'browser',
            entityId: urlWorkspaceId,
            title: 'Example'
          },
          // A terminal's unified tab is self-backed (`id === entityId === the terminal tab id`),
          // which is what puts the parent id — not a surface id — into the group's tabOrder.
          {
            id: 'term-right',
            groupId: 'group-right',
            contentType: 'terminal',
            entityId: 'term-right',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-right',
            worktreeId: 'wt-1',
            ptyId: 'pty-right',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-right': {
          root: { type: 'leaf', leafId: rightLeafId },
          activeLeafId: rightLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [rightLeafId]: 'pty-right' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: docWorkspaceId,
            worktreeId: 'wt-1',
            activePageId: 'page-doc',
            pageIds: ['page-doc'],
            url: 'data:text/html,',
            title: 'report.html',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1,
            docLocation: {
              kind: 'workspace-doc',
              worktreeId: 'wt-1',
              filePath: '/repo/docs/report.html'
            }
          },
          {
            id: urlWorkspaceId,
            worktreeId: 'wt-1',
            activePageId: 'page-url',
            pageIds: ['page-url'],
            url: 'https://example.com/',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 2
          }
        ]
      }
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The presence half: the grouped URL tab beside it does publish, so a projection that had
    // stopped emitting browser tabs — or groups — fails here rather than passing on emptiness.
    expect(snapshot?.tabs).toMatchObject([
      { type: 'browser', browserWorkspaceId: urlWorkspaceId },
      { type: 'terminal', id: `term-right::${rightLeafId}`, parentTabId: 'term-right' }
    ])
    expect(snapshot?.tabGroups).toMatchObject([
      { id: 'group-right', tabOrder: ['unified-url', 'term-right'] }
    ])
    // Mechanical rather than by name: nothing a group points at may be unresolvable in the tab list,
    // whatever the reason it was held back. The terminal is why this resolves through `parentTabId`
    // rather than by id — 'term-right' is published as 'term-right::<leafId>'.
    expect(danglingTabRefs(snapshot)).toEqual([])
    // The same claim one level up: the snapshot's own active-group pointer may not name a group the
    // phone was never sent. 'group-left' is the held-back one, so a pass-through of the desktop's
    // active group fails here.
    expect(danglingGroupRefs(snapshot)).toEqual([])
    // What the reader would actually see go wrong: a group held back has to leave the layout tree
    // with it, or the phone renders a split whose pane can never have anything in it.
    expect(collectLayoutGroupIds(snapshot?.tabGroupLayout)).toEqual(['group-right'])
  })

  // Why a second fixture for the same claim: the test above holds a group back over a browser
  // document, which is one guard. A combined-diff tab is held back by an unrelated one, so a fix
  // written against either guard alone still leaves the other publishing a group id it withheld.
  it('does not name a held-back combined-diff group as the active group', () => {
    const combinedId = 'wt-1::all-diffs::branch::main'
    const state = makeState({
      // The desktop's active group is the one holding only the combined diff.
      activeGroupIdByWorktree: { 'wt-1': 'group-left' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'combined-tab',
            tabOrder: ['combined-tab'],
            recentTabIds: ['combined-tab']
          },
          {
            id: 'group-right',
            activeTabId: 'editor-tab',
            tabOrder: ['editor-tab'],
            recentTabIds: ['editor-tab']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'combined-tab',
            groupId: 'group-left',
            contentType: 'diff',
            entityId: combinedId,
            title: 'Branch Changes (main)'
          },
          {
            id: 'editor-tab',
            groupId: 'group-right',
            contentType: 'editor',
            entityId: '/repo/src/app.ts',
            title: 'app.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: combinedId,
          filePath: '/repo',
          relativePath: 'Branch Changes (main)',
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'diff',
          diffSource: 'combined-branch',
          isDirty: false
        },
        {
          id: '/repo/src/app.ts',
          filePath: '/repo/src/app.ts',
          relativePath: 'src/app.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The presence half: the ordinary editor beside it does publish, so a projection that had
    // stopped emitting groups fails here rather than passing on emptiness.
    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual(['editor-tab'])
    expect(snapshot?.tabGroups?.map((group) => group.id)).toEqual(['group-right'])
    expect(danglingGroupRefs(snapshot)).toEqual([])
    // The display choice, by name: focus lands on the group the phone actually has.
    expect(snapshot?.activeGroupId).toBe('group-right')
  })

  // Why this arm and not just the mounted one above: a terminal occupies its group under the parent
  // tab id but publishes one row per pane, so a terminal with no live pane and no persisted layout
  // publishes none at all. `createTerminalTab` seeds exactly that — `emptyLayoutSnapshot()` — until
  // TerminalPane mounts, so this is the ordinary new-tab window, not a corrupt fixture.
  it('keeps a terminal that publishes no surface rows out of its published group', () => {
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'term-unmounted',
            tabOrder: ['term-unmounted', 'term-mounted'],
            recentTabIds: ['term-unmounted', 'term-mounted']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': { type: 'leaf', groupId: 'group-1' }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'term-unmounted',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-unmounted',
            title: 'Terminal'
          },
          {
            id: 'term-mounted',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-mounted',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-unmounted',
            worktreeId: 'wt-1',
            ptyId: null,
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'term-mounted',
            worktreeId: 'wt-1',
            ptyId: 'pty-mounted',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        // What `createTerminalTab` writes before the pane mounts: a layout with no leaf at all.
        'term-unmounted': { root: null, activeLeafId: null, expandedLeafId: null },
        'term-mounted': {
          root: { type: 'leaf', leafId: mountedLeafId },
          activeLeafId: mountedLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [mountedLeafId]: 'pty-mounted' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The presence half: its neighbour publishes, so a projection that had stopped emitting terminal
    // rows fails here rather than passing on emptiness.
    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual([`term-mounted::${mountedLeafId}`])
    expect(snapshot?.tabGroups).toMatchObject([{ id: 'group-1', tabOrder: ['term-mounted'] }])
    expect(danglingTabRefs(snapshot)).toEqual([])
    expect(danglingGroupRefs(snapshot)).toEqual([])
  })

  // The same terminal alone in its group: holding it back empties the group, so the group and the
  // pane the layout gave it have to go with it rather than leaving the client an empty split.
  it('drops a group whose only terminal publishes no surface rows', () => {
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-empty' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-empty',
            activeTabId: 'term-unmounted',
            tabOrder: ['term-unmounted'],
            recentTabIds: ['term-unmounted']
          },
          {
            id: 'group-right',
            activeTabId: 'term-mounted',
            tabOrder: ['term-mounted'],
            recentTabIds: ['term-mounted']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-empty' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'term-unmounted',
            groupId: 'group-empty',
            contentType: 'terminal',
            entityId: 'term-unmounted',
            title: 'Terminal'
          },
          {
            id: 'term-mounted',
            groupId: 'group-right',
            contentType: 'terminal',
            entityId: 'term-mounted',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-unmounted',
            worktreeId: 'wt-1',
            ptyId: null,
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'term-mounted',
            worktreeId: 'wt-1',
            ptyId: 'pty-mounted',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-unmounted': { root: null, activeLeafId: null, expandedLeafId: null },
        'term-mounted': {
          root: { type: 'leaf', leafId: mountedLeafId },
          activeLeafId: mountedLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [mountedLeafId]: 'pty-mounted' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabGroups?.map((group) => group.id)).toEqual(['group-right'])
    expect(collectLayoutGroupIds(snapshot?.tabGroupLayout)).toEqual(['group-right'])
    expect(snapshot?.activeGroupId).toBe('group-right')
    expect(unplacedPublishedGroupIds(snapshot)).toEqual([])
    expect(danglingTabRefs(snapshot)).toEqual([])
    expect(danglingGroupRefs(snapshot)).toEqual([])
  })

  // Why this arm: the mirrored-tab guard is applied twice — once choosing which terminals the group
  // projection may name, once emitting rows. Ablating the projection copy alone leaves the emit copy
  // holding the tab list, so without this the projection's copy is unpinned and its removal is
  // invisible: the group would name a tab the client is never sent a row for.
  it('keeps a web-only mirrored terminal out of its published group', () => {
    const mirroredLeafId = '33333333-3333-4333-8333-333333333333'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'web-terminal-host%3A%3Aleaf',
            tabOrder: ['web-terminal-host%3A%3Aleaf', 'term-mounted'],
            recentTabIds: ['web-terminal-host%3A%3Aleaf', 'term-mounted']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': { type: 'leaf', groupId: 'group-1' }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-host%3A%3Aleaf',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'web-terminal-host%3A%3Aleaf',
            title: 'Mirrored'
          },
          {
            id: 'term-mounted',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-mounted',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-host%3A%3Aleaf',
            worktreeId: 'wt-1',
            ptyId: null,
            title: 'Mirrored',
            defaultTitle: 'Mirrored',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'term-mounted',
            worktreeId: 'wt-1',
            ptyId: 'pty-mounted',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        // A persisted leaf, so it is the mirror guard holding this back and not the empty-layout one.
        'web-terminal-host%3A%3Aleaf': {
          root: { type: 'leaf', leafId: mirroredLeafId },
          activeLeafId: mirroredLeafId,
          expandedLeafId: null
        },
        'term-mounted': {
          root: { type: 'leaf', leafId: mountedLeafId },
          activeLeafId: mountedLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [mountedLeafId]: 'pty-mounted' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual([`term-mounted::${mountedLeafId}`])
    expect(danglingTabRefs(snapshot)).toEqual([])
    expect(danglingGroupRefs(snapshot)).toEqual([])
  })

  // Why this arm: the fallback that rescues editor tabs the group projection missed takes their
  // `groupId` on faith and mints a published group for it. A group id that is not one of the host's
  // is one the host layout cannot place, so the tab would arrive in a group with no pane. Hydration
  // (`adoptGrouplessTabs`) is what keeps that groupId live today, which is why this is a fixture and
  // not a report — but the projection must not be the thing that invents the id either.
  it('does not mint a published group for an editor tab whose group does not exist', () => {
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', activeTabId: 'ed-1', tabOrder: ['ed-1'], recentTabIds: [] }]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': { type: 'leaf', groupId: 'group-1' }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'ed-1',
            groupId: 'group-1',
            contentType: 'editor',
            entityId: '/repo/a.ts',
            title: 'a.ts'
          },
          {
            id: 'ed-stranded',
            groupId: 'group-never-published',
            contentType: 'editor',
            entityId: '/repo/b.ts',
            title: 'b.ts'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: '/repo/a.ts',
          filePath: '/repo/a.ts',
          relativePath: 'a.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        },
        {
          id: '/repo/b.ts',
          filePath: '/repo/b.ts',
          relativePath: 'b.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit',
          isDirty: false
        }
      ]
    } as unknown as Parameters<typeof makeState>[0])

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The tab still publishes — the repair is where it lands, not whether it survives.
    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual(['ed-1', 'ed-stranded'])
    expect(snapshot?.tabGroups).toMatchObject([
      { id: 'group-1', tabOrder: ['ed-1', 'ed-stranded'] }
    ])
    expect(unplacedPublishedGroupIds(snapshot)).toEqual([])
    expect(danglingTabRefs(snapshot)).toEqual([])
    expect(danglingGroupRefs(snapshot)).toEqual([])
  })

  it('does not recover unsupported combined diff tabs through split-group fallback', () => {
    const combinedId = 'wt-1::all-diffs::branch::main'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-right' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-right',
            activeTabId: 'combined-tab-right',
            tabOrder: [],
            recentTabIds: []
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'combined-tab-right',
            groupId: 'group-right',
            contentType: 'diff',
            entityId: combinedId,
            title: 'Branch Changes (main)'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: [
        {
          id: combinedId,
          filePath: '/repo',
          relativePath: 'Branch Changes (main)',
          worktreeId: 'wt-1',
          language: 'plaintext',
          mode: 'diff',
          diffSource: 'combined-branch',
          isDirty: false
        }
      ]
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toEqual([])
    expect(snapshot?.tabGroups).toBeUndefined()
    // Nothing was published, so there is no group left to point at.
    expect(danglingGroupRefs(snapshot)).toEqual([])
    expect(snapshot?.activeGroupId).toBeNull()
  })
  // Why the groups-empty arm: with no host groups the projection returns the legacy nav order, which
  // is built from every terminal tab rather than the filtered publishable set, so the per-tab guard
  // in the order loop is the only thing holding a web mirror back on this path.
  it('keeps a web-mirrored terminal out of the legacy nav order projection', () => {
    const mirroredLeafId = '33333333-3333-4333-8333-333333333333'
    const state = makeState({
      groupsByWorktree: { 'wt-1': [] } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-term-host',
            groupId: null,
            contentType: 'terminal',
            entityId: 'web-terminal-term-host',
            title: 'Mirrored'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-term-host',
            worktreeId: 'wt-1',
            ptyId: 'remote:pty-host',
            title: 'Mirrored',
            defaultTitle: 'Mirrored',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'web-terminal-term-host': {
          root: { type: 'leaf', leafId: mirroredLeafId },
          activeLeafId: mirroredLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [mirroredLeafId]: 'remote:pty-host' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    // The persisted layout resolves a leaf, so without the guard this publishes a surface row.
    expect(snapshot?.tabs).toEqual([])
    expect(danglingTabRefs(snapshot)).toEqual([])
  })
})
