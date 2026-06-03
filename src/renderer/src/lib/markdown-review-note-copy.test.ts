import { describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../shared/types'
import {
  copyMarkdownReviewNotesForAgent,
  type MarkdownReviewNoteClipboardWriter
} from './markdown-review-note-copy'
import type { MarkdownReviewNote } from './markdown-review-notes'

function note(overrides: Partial<Omit<DiffComment, 'source'>> = {}): MarkdownReviewNote {
  return {
    id: 'n1',
    worktreeId: 'wt1',
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: 2,
    body: 'needs detail',
    createdAt: 0,
    side: 'modified',
    ...overrides
  }
}

describe('copyMarkdownReviewNotesForAgent', () => {
  it('copies the same formatted markdown-review payload used by agent handoff', async () => {
    const writeClipboardText = vi.fn<MarkdownReviewNoteClipboardWriter>().mockResolvedValue()

    const copied = await copyMarkdownReviewNotesForAgent({
      notes: [note({ selectedText: 'specific phrase', body: 'reword this' })],
      content: 'one\nspecific phrase in a longer line',
      writeClipboardText
    })

    expect(copied).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledOnce()
    expect(writeClipboardText).toHaveBeenCalledWith(
      [
        'File: README.md',
        'Source: markdown',
        'Line 2',
        'Excerpt:',
        '> specific phrase',
        'User comment: "reword this"'
      ].join('\n')
    )
  })

  it('does not write the clipboard when there are no notes', async () => {
    const writeClipboardText = vi.fn<MarkdownReviewNoteClipboardWriter>().mockResolvedValue()

    const copied = await copyMarkdownReviewNotesForAgent({
      notes: [],
      content: 'one',
      writeClipboardText
    })

    expect(copied).toBe(false)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })
})
