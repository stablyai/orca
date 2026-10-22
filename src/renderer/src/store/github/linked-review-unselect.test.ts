import { describe, expect, it } from 'vitest'
import {
  getWorkspaceAttachments,
  normalizeWorkspaceAttachmentUpdate
} from '../../../../shared/workspace-attachments'
import type { WorkspaceAttachment } from '../../../../shared/worktree/types'
import { buildUnselectLinkedReviewUpdate } from './linked-review-unselect'

const pr = (number: number): WorkspaceAttachment => ({
  provider: 'github',
  type: 'pr',
  number,
  url: `https://github.com/o/r/pull/${number}`
})

describe('buildUnselectLinkedReviewUpdate', () => {
  it('unselects the review without deleting references added to the workspace', () => {
    const meta = normalizeWorkspaceAttachmentUpdate(undefined, { linkedItems: [pr(1), pr(2)] })
    expect(meta.linkedPR).toBe(1)

    const update = buildUnselectLinkedReviewUpdate(meta)
    const next = {
      ...meta,
      ...normalizeWorkspaceAttachmentUpdate(meta, {
        ...update,
        linkedItemsBase: getWorkspaceAttachments(meta),
        linkedItemsSelectionChanged: true
      })
    }

    expect(next.linkedPR).toBeNull()
    expect(getWorkspaceAttachments(next).map((item) => item.number)).toEqual([1, 2])
  })
})
