import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import { collectHydratedOrphanEditorFileIds } from './orphan-editor-file-ids'

const WORKTREE_ID = 'repo-1::/workspace'
const OTHER_WORKTREE_ID = 'repo-2::/other-workspace'
const TABBED_FILE_ID = '/workspace/tabbed.ts'
const ORPHAN_FILE_ID = '/workspace/orphan.ts'

function editorTab(entityId: string, worktreeId = WORKTREE_ID): Tab {
  return {
    id: `tab:${entityId}`,
    entityId,
    groupId: 'group-1',
    worktreeId,
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function orphansFor(
  orphanFileIdsByWorktree: Map<string, Set<string>>,
  worktreeId = WORKTREE_ID
): string[] {
  return [...(orphanFileIdsByWorktree.get(worktreeId) ?? [])]
}

function collectOrphans(
  orphan: { isDirty?: boolean },
  editorDrafts: Record<string, string>
): string[] {
  return orphansFor(
    collectHydratedOrphanEditorFileIds(
      [
        { id: TABBED_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false },
        { id: ORPHAN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: orphan.isDirty ?? false }
      ],
      { [WORKTREE_ID]: [editorTab(TABBED_FILE_ID)] },
      { [WORKTREE_ID]: TABBED_FILE_ID },
      editorDrafts
    )
  )
}

describe('collectHydratedOrphanEditorFileIds', () => {
  it('reports a clean document no editor tab references', () => {
    expect(collectOrphans({}, {})).toEqual([ORPHAN_FILE_ID])
  })

  it('keeps an orphan whose unsaved draft has not flushed into isDirty yet', () => {
    expect(collectOrphans({}, { [ORPHAN_FILE_ID]: 'typed but not flushed' })).toEqual([])
  })

  it('keeps an orphan that already flushed its dirty flag', () => {
    expect(collectOrphans({ isDirty: true }, {})).toEqual([])
  })

  it('skips a worktree missing from the hydrated tab map', () => {
    expect(
      collectHydratedOrphanEditorFileIds(
        [{ id: ORPHAN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false }],
        {},
        {},
        {}
      ).size
    ).toBe(0)
  })

  it('prunes a worktree whose hydrated tab list is present but empty', () => {
    expect(
      orphansFor(
        collectHydratedOrphanEditorFileIds(
          [{ id: ORPHAN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false }],
          { [WORKTREE_ID]: [] },
          {},
          {}
        )
      )
    ).toEqual([ORPHAN_FILE_ID])
  })

  it('reports an orphan only under the worktree it is orphaned in', () => {
    // Why the shared id: an unowned editor id is the bare file path, so the same id names a live
    // document in the other worktree.
    const orphanFileIdsByWorktree = collectHydratedOrphanEditorFileIds(
      [
        { id: ORPHAN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false },
        { id: ORPHAN_FILE_ID, worktreeId: OTHER_WORKTREE_ID, isDirty: false }
      ],
      {
        [WORKTREE_ID]: [],
        [OTHER_WORKTREE_ID]: [editorTab(ORPHAN_FILE_ID, OTHER_WORKTREE_ID)]
      },
      {},
      {}
    )

    expect(orphansFor(orphanFileIdsByWorktree)).toEqual([ORPHAN_FILE_ID])
    expect(orphansFor(orphanFileIdsByWorktree, OTHER_WORKTREE_ID)).toEqual([])
  })
})
