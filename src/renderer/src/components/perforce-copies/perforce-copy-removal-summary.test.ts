import { describe, expect, it } from 'vitest'
import type { WorkspaceCopyRemovalPreview } from '../../../../shared/perforce/workspace-copy/workspace-copy-types'
import { summarizeCopyRemoval } from './perforce-copy-removal-summary'

const PREVIEW: WorkspaceCopyRemovalPreview = {
  name: 'copy-1',
  client: 'ws_wt_copy-1',
  copyRoot: 'D:\\ws.wt\\copy-1',
  markerPath: 'D:\\ws.wt\\copy-1.p4-worktree.json',
  clientExists: true,
  folderExists: true,
  stream: '//s/main',
  openFiles: { count: 2, sample: ['a.cs', 'b.cs'] },
  pendingChanges: [
    { change: 11, description: 'empty one', shelvedFiles: 0 },
    { change: 12, description: 'shelved work\nsecond line', shelvedFiles: 3 }
  ],
  childStream: null,
  processesHoldingFolder: [],
  blockers: { openFiles: true, shelves: true }
}

describe('summarizeCopyRemoval', () => {
  it('lists only what the chosen options delete, and says the source is safe', () => {
    const summary = summarizeCopyRemoval(PREVIEW, {}, 'D:\\ws')
    expect(summary.deletes).toEqual([
      'The folder D:\\ws.wt\\copy-1 and everything in it.',
      'Pending changelist 11 “empty one”.',
      'The Perforce client ws_wt_copy-1 on the server.',
      "The copy's marker file D:\\ws.wt\\copy-1.p4-worktree.json."
    ])
    expect(summary.keeps[0]).toContain('D:\\ws')
  })

  it('adds reverted files and shelves once the user opts in', () => {
    const summary = summarizeCopyRemoval(
      PREVIEW,
      { revertOpenFiles: true, deleteShelves: true },
      'D:\\ws'
    )
    expect(summary.deletes).toContain(
      'The changes in 2 checked-out file(s): they are reverted, then deleted with the folder.'
    )
    expect(summary.deletes).toContain('Changelist 12 “shelved work” and its 3 shelved file(s).')
  })

  it('says first which programs are ended, only once the user opts in', () => {
    const holders = [
      { pid: 10, name: 'indexer.exe', commandLine: 'indexer.exe --workspace copy-1', startedAt: 5 },
      { pid: 11, name: 'Unity.exe', commandLine: 'Unity.exe -projectPath copy-1', startedAt: 6 }
    ]
    const withHolders = { ...PREVIEW, holders }
    expect(summarizeCopyRemoval(withHolders, {}, 'D:\\ws').deletes[0]).toContain('The folder')
    const summary = summarizeCopyRemoval(
      withHolders,
      { endHolders: [{ pid: 10, startedAt: 5 }] },
      'D:\\ws'
    )
    expect(summary.deletes[0]).toBe('Ends indexer.exe first; anything unsaved in them is lost.')
  })

  it('keeps a child stream with submitted work and deletes an unused one', () => {
    const kept = summarizeCopyRemoval(
      {
        ...PREVIEW,
        childStream: { stream: '//s/main_wt_copy-1', submittedChanges: 2, parent: '//s/main' }
      },
      {},
      'D:\\ws'
    )
    expect(kept.keeps.join(' ')).toContain('p4 copy -S //s/main_wt_copy-1')
    const deleted = summarizeCopyRemoval(
      {
        ...PREVIEW,
        childStream: { stream: '//s/main_wt_copy-1', submittedChanges: 0, parent: '//s/main' }
      },
      {},
      'D:\\ws'
    )
    expect(deleted.deletes).toContain(
      "The copy's own stream //s/main_wt_copy-1 (nothing was submitted to it)."
    )
  })
})
