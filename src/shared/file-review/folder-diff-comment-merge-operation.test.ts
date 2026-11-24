import { describe, expect, it, vi } from 'vitest'
import type { DiffComment } from './diff-comment-types'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import { applyDiffCommentWrite } from './diff-comment-mutation'
import {
  ABSENT_NOTE_VERSION,
  diffCommentVersion,
  FOLDER_DIFF_COMMENT_SNAPSHOT_MAX_BYTES,
  type FolderDiffCommentMergeRequest
} from './folder-diff-comment-merge'
import { mergeFolderDiffCommentsOnHost } from './folder-diff-comment-merge-operation'

function note(id: string, body: string): DiffComment {
  return {
    id,
    worktreeId: 'folder:f1',
    filePath: 'README.md',
    lineNumber: 1,
    body,
    side: 'modified',
    createdAt: 1
  }
}

function row(diffComments: DiffComment[], overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'folder',
    folderPath: '/w',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 10,
    updatedAt: 10,
    diffComments,
    ...overrides
  }
}

/** A host store that merges like the real one, recording every effect. */
function host(rows: FolderWorkspace[], options: { visible?: boolean; fenced?: boolean } = {}) {
  const effects = { updates: 0, notifies: 0 }
  let clock = 100
  return {
    effects,
    rows,
    api: {
      rows: () => rows,
      visibleRows: () => (options.visible === false ? [] : rows),
      assertWritable: () => {
        if (options.fenced) {
          throw new Error('fenced')
        }
      },
      update: (id: string, updates: { diffComments: DiffComment[]; diffCommentsBase: DiffComment[] }) => {
        const target = rows.findLast((entry) => entry.id === id)
        if (!target) {
          return null
        }
        effects.updates += 1
        target.diffComments = applyDiffCommentWrite(target.diffComments, updates)
        target.updatedAt = clock--
        return target
      },
      notify: vi.fn(() => {
        effects.notifies += 1
      })
    }
  }
}

function merge(
  base: DiffComment[],
  list: DiffComment[],
  overrides: Partial<FolderDiffCommentMergeRequest> = {}
): FolderDiffCommentMergeRequest {
  return {
    requestId: 'r1',
    folderWorkspaceId: 'f1',
    expectedCreatedAt: 10,
    mode: 'merge',
    diffCommentsBase: base,
    diffComments: list,
    ...overrides
  }
}

describe('merge-only folder note operation', () => {
  it('changes only the touched notes and reports what the host now holds for each', () => {
    const big = note('big', 'x'.repeat(1000))
    const h = host([row([big, note('x', 'v1'), note('peer', 'from another device')])])

    const receipt = mergeFolderDiffCommentsOnHost(
      h.api,
      merge([note('x', 'v1')], [note('x', 'v2'), note('y', 'new')])
    )

    expect(h.rows[0].diffComments?.map(({ id, body }) => [id, body.length > 10 ? 'big' : body])).toEqual([
      ['big', 'big'],
      ['x', 'v2'],
      ['peer', 'from another device'],
      ['y', 'new']
    ])
    expect(receipt).toMatchObject({ outcome: 'applied', requestId: 'r1', createdAt: 10 })
    expect(receipt.outcome === 'applied' && receipt.verdict).toEqual([
      { id: 'x', version: diffCommentVersion(note('x', 'v2')) },
      { id: 'y', version: diffCommentVersion(note('y', 'new')) }
    ])
    expect(h.effects).toEqual({ updates: 1, notifies: 1 })
  })

  it('reports an edit of a note another device deleted as absent', () => {
    const h = host([row([])])
    const receipt = mergeFolderDiffCommentsOnHost(h.api, merge([note('x', 'v1')], [note('x', 'v2')]))
    expect(receipt.outcome === 'applied' && receipt.verdict).toEqual([
      { id: 'x', version: ABSENT_NOTE_VERSION }
    ])
  })

  it.each([
    ['a recreated row', host([row([note('x', 'v1')], { createdAt: 11 })]), 'incarnation_changed'],
    ['two rows with the id', host([row([note('x', 'v1')]), row([note('x', 'v1')])]), 'duplicate_row'],
    ['a hidden row', host([row([note('x', 'v1')])], { visible: false }), 'not_found'],
    ['a fenced row', host([row([note('x', 'v1')])], { fenced: true }), 'refused'],
    ['a missing row', host([]), 'not_found']
  ])('refuses %s before touching anything', (_name, h, outcome) => {
    const before = JSON.stringify(h.rows)
    const receipt = mergeFolderDiffCommentsOnHost(h.api, merge([note('x', 'v1')], [note('x', 'v2')]))
    expect(receipt).toEqual({ outcome, requestId: 'r1', folderWorkspaceId: 'f1' })
    expect(JSON.stringify(h.rows)).toBe(before)
    expect(h.effects).toEqual({ updates: 0, notifies: 0 })
  })

  it('refuses a touched id that names two notes, in the request or on the host', () => {
    const stored = host([row([note('x', 'a'), note('x', 'b')])])
    expect(
      mergeFolderDiffCommentsOnHost(stored.api, merge([note('x', 'a')], [note('x', 'c')])).outcome
    ).toBe('ambiguous_note_ids')
    const requested = host([row([])])
    expect(
      mergeFolderDiffCommentsOnHost(requested.api, merge([], [note('y', 'a'), note('y', 'b')]))
        .outcome
    ).toBe('ambiguous_note_ids')
    expect(stored.effects.updates + requested.effects.updates).toBe(0)
  })

  it('reads without writing, saving or notifying', () => {
    const h = host([row([note('x', 'v1')])])
    const receipt = mergeFolderDiffCommentsOnHost(h.api, merge([], [], { mode: 'read' }))
    expect(receipt).toMatchObject({ outcome: 'read', snapshot: [note('x', 'v1')], updatedAt: 10 })
    expect(h.effects).toEqual({ updates: 0, notifies: 0 })
  })

  it('leaves out a snapshot too large for the reply but still gives the verdict', () => {
    const huge = note('huge', 'x'.repeat(FOLDER_DIFF_COMMENT_SNAPSHOT_MAX_BYTES))
    const h = host([row([huge])])
    const receipt = mergeFolderDiffCommentsOnHost(h.api, merge([], [note('y', 'tiny')]))
    expect(receipt.outcome === 'applied' && receipt.snapshot).toBeUndefined()
    expect(receipt.outcome === 'applied' && receipt.verdict).toEqual([
      { id: 'y', version: diffCommentVersion(note('y', 'tiny')) }
    ])
  })
})
