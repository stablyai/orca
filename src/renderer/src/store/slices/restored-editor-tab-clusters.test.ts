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
