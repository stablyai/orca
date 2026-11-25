import { describe, expect, it } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { applyDiffCommentWrite } from '../../../../../shared/file-review/diff-comment-mutation'
import type {
  FolderDiffCommentMergeRequest,
  FolderDiffCommentReceipt
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { mergeFolderDiffCommentsOnHost } from '../../../../../shared/file-review/folder-diff-comment-merge-operation'
import { checkFolderNoteReceipt } from './folder-note-receipt'

function note(id: string, body: string): DiffComment {
  return {
    id,
    worktreeId: 'folder:f1',
    filePath: 'a.md',
    lineNumber: 1,
    body,
    side: 'modified',
    createdAt: 1
  }
}

/** The real host operation on a row holding `stored`. */
function hostReceipt(stored: DiffComment[], request: FolderDiffCommentMergeRequest) {
  let row = {
    id: 'f1',
    createdAt: 7,
    updatedAt: 1,
    diffComments: stored
  } as unknown as FolderWorkspace
  const receipt = mergeFolderDiffCommentsOnHost(
    {
      rows: () => [row],
      visibleRows: () => [row],
      assertWritable: () => {},
      update: (_id, updates) => {
        row = { ...row, diffComments: applyDiffCommentWrite(row.diffComments, updates) }
        return row
      },
      notify: () => {}
    },
    request
  )
  return receipt as Extract<FolderDiffCommentReceipt, { outcome: 'applied' | 'read' }>
}

function merge(base: DiffComment[], after: DiffComment[]): FolderDiffCommentMergeRequest {
  return {
    requestId: 'r1',
    folderWorkspaceId: 'f1',
    expectedCreatedAt: 7,
    mode: 'merge',
    diffCommentsBase: base,
    diffComments: after
  }
}

const A = note('A', 'a')
const H = note('H', 'h')

describe('folder note receipt placement', () => {
  it('accepts an in-place edit with no placement, and refuses one falsely labelled as appended', () => {
    const request = merge([note('B', 'v1')], [note('B', 'v2')])
    const receipt = hostReceipt([A, note('B', 'v1'), H], request)

    expect(checkFolderNoteReceipt(receipt, request)?.added).toEqual(new Set())
    expect(checkFolderNoteReceipt({ ...receipt, added: ['B'] }, request)).toBeNull()
  })

  it('refuses a claimed append whose verdict holds a version other than the one requested', () => {
    const request = merge([], [note('C', 'mine')])
    // The host already held another C, so it kept that one and appended nothing.
    const receipt = hostReceipt([A, note('C', 'theirs')], request)

    expect(checkFolderNoteReceipt(receipt, request)?.added).toEqual(new Set())
    expect(checkFolderNoteReceipt({ ...receipt, added: ['C'] }, request)).toBeNull()
  })

  it('accepts a re-add the host appended, and refuses a snapshot that does not end with it', () => {
    const request = merge([], [note('B', 'v1')])
    const receipt = hostReceipt([A, H], request)

    expect(checkFolderNoteReceipt(receipt, request)?.added).toEqual(new Set(['B']))
    expect(
      checkFolderNoteReceipt({ ...receipt, snapshot: [A, note('B', 'v1'), H] }, request)
    ).toBeNull()
  })

  it('refuses placement on a read', () => {
    const request: FolderDiffCommentMergeRequest = { ...merge([], []), mode: 'read' }
    const receipt = hostReceipt([A], request)

    expect(checkFolderNoteReceipt(receipt, request)).not.toBeNull()
    expect(checkFolderNoteReceipt({ ...receipt, added: ['A'] }, request)).toBeNull()
  })
})
