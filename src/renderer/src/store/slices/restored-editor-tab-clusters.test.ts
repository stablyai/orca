import { describe, expect, it } from 'vitest'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import {
  createTestStore,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
import { carryRestoredEditorTabClusters } from './editor/actions/restored-editor-tab-clusters'
import { getHiddenClusterTabIds } from '../../../../shared/tab-types'

const SOURCE = 'repo1::/path/source'
const TARGET = 'repo1::/path/target'
const OLD = 'legacy-editor-id'
const PREVIEW = 'legacy-preview-id'

describe('restored editor cluster ownership', () => {
  it('carries rekeyed moved members in pane order while retaining source and destination clusters', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: SOURCE, repoId: 'repo1', path: '/path/source' }),
          makeWorktree({ id: TARGET, repoId: 'repo1', path: '/path/target' })
        ]
      },
      openFiles: [
        makeOpenFile({ id: OLD, worktreeId: SOURCE, filePath: '/path/target/a.md' }),
        makeOpenFile({
          id: PREVIEW,
          worktreeId: SOURCE,
          filePath: '/path/target/a.md',
          mode: 'markdown-preview',
          markdownPreviewSourceFileId: OLD
        }),
        makeOpenFile({ id: 'source-sibling', worktreeId: SOURCE }),
        makeOpenFile({ id: 'target-sibling', worktreeId: TARGET })
      ],
      unifiedTabsByWorktree: {
        [SOURCE]: [PREVIEW, OLD, 'source-sibling'].map((id) =>
          makeUnifiedTab({ id, worktreeId: SOURCE, groupId: 'source-pane', contentType: 'editor' })
        ),
        [TARGET]: [
          makeUnifiedTab({
            id: 'target-sibling',
            worktreeId: TARGET,
            groupId: 'target-pane',
            contentType: 'editor'
          })
        ]
      },
      activeGroupIdByWorktree: { [SOURCE]: 'source-pane', [TARGET]: 'target-pane' },
      groupsByWorktree: {
        [SOURCE]: [
          makeTabGroup({
            id: 'source-pane',
            worktreeId: SOURCE,
            activeTabId: OLD,
            tabOrder: [OLD, PREVIEW, 'source-sibling'],
            tabClusters: [
              {
                id: 'cluster',
                name: 'Source work',
                color: 'blue',
                collapsed: true,
                tabIds: [OLD, PREVIEW, 'source-sibling']
              }
            ]
          })
        ],
        [TARGET]: [
          makeTabGroup({
            id: 'target-pane',
            worktreeId: TARGET,
            activeTabId: 'target-sibling',
            tabOrder: ['target-sibling'],
            tabClusters: [
              {
                id: 'cluster',
                name: 'Target work',
                color: 'red',
                collapsed: false,
                tabIds: ['target-sibling']
              }
            ]
          })
        ]
      }
    })
    const result = store.getState().reparentRestoredEditorFileOwner({
      fileId: OLD,
      targetWorktreeId: TARGET,
      targetRelativePath: 'a.md',
      targetExecutionHostId: 'local',
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(
        store.getState(),
        TARGET,
        null,
        true
      )
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(`Owner migration failed: ${result.reason}`)
    }

    const previewId = `markdown-preview::${result.fileId}`
    const source = store.getState().groupsByWorktree[SOURCE][0]
    const target = store.getState().groupsByWorktree[TARGET][0]
    expect(source.tabOrder).toEqual(['source-sibling'])
    expect(source.tabClusters?.[0].tabIds).toEqual(['source-sibling'])
    expect(target.tabOrder).toEqual(['target-sibling', result.fileId, previewId])
    expect(target.tabClusters?.find((cluster) => cluster.name === 'Target work')?.tabIds).toEqual([
      'target-sibling'
    ])
    const carried = target.tabClusters?.find((cluster) => cluster.name === 'Source work')
    expect(carried?.tabIds).toEqual([result.fileId, previewId])
    expect(carried?.collapsed).toBe(true)
    expect(carried?.color).toBe('blue')
    expect(carried?.id).not.toBe('cluster')
    expect(store.getState().getTab(result.fileId)?.worktreeId).toBe(TARGET)
  })

  it('keeps a collapsed cluster member and its shown tab in place when its host changes', () => {
    const store = createTestStore()
    const ids = ['source-sibling', OLD]
    const targetExecutionHostId = 'ssh:ssh-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: SOURCE, repoId: 'repo1', path: '/path/source' })]
      },
      openFiles: ids.map((id) =>
        makeOpenFile({
          id,
          worktreeId: SOURCE,
          filePath: id === OLD ? '/path/source/a.md' : id
        })
      ),
      unifiedTabsByWorktree: {
        [SOURCE]: ids.map((id) =>
          makeUnifiedTab({
            id,
            worktreeId: SOURCE,
            groupId: 'source-pane',
            contentType: 'editor',
            executionHostId: 'local'
          })
        )
      },
      activeGroupIdByWorktree: { [SOURCE]: 'source-pane' },
      groupsByWorktree: {
        [SOURCE]: [
          makeTabGroup({
            id: 'source-pane',
            worktreeId: SOURCE,
            activeTabId: OLD,
            tabOrder: ids,
            tabClusters: [
              {
                id: 'cluster',
                name: 'Work',
                color: 'blue',
                collapsed: true,
                tabIds: ids,
                shownTabId: OLD
              }
            ]
          })
        ]
      }
    })
    store.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({
        ...file,
        operationProvenance: captureEditorFileOperationProvenance(state, SOURCE, null, true)
      })),
      repos: state.repos.map((repo) => ({
        ...repo,
        connectionId: 'ssh-1',
        executionHostId: targetExecutionHostId
      })),
      worktreesByRepo: {
        repo1: state.worktreesByRepo.repo1.map((worktree) => ({
          ...worktree,
          hostId: targetExecutionHostId
        }))
      }
    }))

    const result = store.getState().reparentRestoredEditorFileOwner({
      fileId: OLD,
      targetWorktreeId: SOURCE,
      targetRelativePath: 'a.md',
      targetExecutionHostId,
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(
        store.getState(),
        SOURCE,
        null,
        true
      )
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(`Owner migration failed: ${result.reason}`)
    }
    expect(result.fileId).not.toBe(OLD)
    const group = store.getState().groupsByWorktree[SOURCE][0]
    expect(group.tabOrder).toEqual(['source-sibling', result.fileId])
    expect(group.tabClusters).toEqual([
      {
        id: 'cluster',
        name: 'Work',
        color: 'blue',
        collapsed: true,
        tabIds: ['source-sibling', result.fileId],
        shownTabId: result.fileId
      }
    ])
  })

  it('keeps the source pane on its visible MRU successor and records the visit', () => {
    const store = createTestStore()
    const ids = [OLD, 'hidden-member', 'visible-sibling']
    seedStore(store, {
      activeWorktreeId: SOURCE,
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: SOURCE, repoId: 'repo1', path: '/path/source' }),
          makeWorktree({ id: TARGET, repoId: 'repo1', path: '/path/target' })
        ]
      },
      openFiles: [
        makeOpenFile({ id: OLD, worktreeId: SOURCE, filePath: '/path/target/a.md' }),
        ...ids.slice(1).map((id) => makeOpenFile({ id, worktreeId: SOURCE }))
      ],
      unifiedTabsByWorktree: {
        [SOURCE]: ids.map((id) =>
          makeUnifiedTab({ id, worktreeId: SOURCE, groupId: 'source-pane', contentType: 'editor' })
        )
      },
      groupsByWorktree: {
        [SOURCE]: [
          makeTabGroup({
            id: 'source-pane',
            worktreeId: SOURCE,
            activeTabId: OLD,
            tabOrder: ids,
            tabClusters: [
              {
                id: 'cluster',
                name: 'Work',
                color: 'blue',
                collapsed: false,
                tabIds: [OLD, 'hidden-member']
              }
            ]
          })
        ]
      },
      activeGroupIdByWorktree: { [SOURCE]: 'source-pane' },
      layoutByWorktree: { [SOURCE]: { type: 'leaf', groupId: 'source-pane' } }
    })
    store.getState().activateTab('visible-sibling')
    store.getState().activateTab('hidden-member')
    store.getState().activateTab(OLD)
    store.getState().setTabClusterCollapsed('source-pane', 'cluster', true)

    const result = store.getState().reparentRestoredEditorFileOwner({
      fileId: OLD,
      targetWorktreeId: TARGET,
      targetRelativePath: 'a.md',
      targetExecutionHostId: 'local',
      targetRuntimeEnvironmentId: null,
      targetOperationProvenance: captureEditorFileOperationProvenance(
        store.getState(),
        TARGET,
        null,
        true
      )
    })
    expect(result.ok).toBe(true)
    const source = store.getState().groupsByWorktree[SOURCE][0]
    expect(source.tabOrder).toEqual(['hidden-member', 'visible-sibling'])
    expect(source.activeTabId).toBe('visible-sibling')
    expect(source.recentTabIds).toEqual(['hidden-member', 'visible-sibling'])
    expect([...getHiddenClusterTabIds(source)]).toEqual(['hidden-member'])
    expect(source.tabClusters?.[0].collapsed).toBe(true)
  })

  it('gives a partially transferred cluster its own chip identity even without a target collision', () => {
    const source = makeTabGroup({
      id: 'source',
      worktreeId: SOURCE,
      tabOrder: [OLD, 'remaining'],
      tabClusters: [
        { id: 'work', name: 'Work', color: 'blue', collapsed: false, tabIds: [OLD, 'remaining'] }
      ]
    })
    const target = makeTabGroup({ id: 'target', worktreeId: TARGET })
    const carried = carryRestoredEditorTabClusters(
      target,
      [source],
      new Set([OLD]),
      new Map([[OLD, 'owned-editor']])
    )
    expect(carried?.[0].tabIds).toEqual(['owned-editor'])
    expect(carried?.[0].id).not.toBe(source.tabClusters?.[0].id)
    expect(source.tabClusters?.[0].tabIds).toEqual([OLD, 'remaining'])
  })

  it('retains full-transfer chip identity unless another target cluster already owns it', () => {
    const source = makeTabGroup({
      id: 'source',
      worktreeId: SOURCE,
      tabOrder: [OLD],
      tabClusters: [{ id: 'work', name: 'Source', color: 'blue', collapsed: true, tabIds: [OLD] }]
    })
    const emptyTarget = makeTabGroup({ id: 'target', worktreeId: TARGET })
    const movedIds = new Set([OLD])
    const rekey = new Map([[OLD, 'owned-editor']])
    expect(carryRestoredEditorTabClusters(emptyTarget, [source], movedIds, rekey)?.[0].id).toBe(
      'work'
    )

    const occupiedTarget = makeTabGroup({
      id: 'target',
      worktreeId: TARGET,
      tabOrder: ['target-member'],
      tabClusters: [
        { id: 'work', name: 'Target', color: 'red', collapsed: false, tabIds: ['target-member'] }
      ]
    })
    const carried = carryRestoredEditorTabClusters(occupiedTarget, [source], movedIds, rekey)
    expect(carried?.find((cluster) => cluster.name === 'Target')?.tabIds).toEqual(['target-member'])
    const moved = carried?.find((cluster) => cluster.name === 'Source')
    expect(moved?.tabIds).toEqual(['owned-editor'])
    expect(moved?.id).not.toBe('work')
  })
})
