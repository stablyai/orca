import { describe, expect, it } from 'vitest'
import type { MarkdownDocument } from '../../../../shared/types'
import {
  retainMarkdownDocumentWorktreeSnapshot,
  type MarkdownDocumentWorktreeSnapshot
} from './markdown-document-worktree-retention'

function documents(name: string): MarkdownDocument[] {
  return [
    {
      filePath: `/repo/${name}.md`,
      relativePath: `${name}.md`,
      basename: `${name}.md`,
      name
    }
  ]
}

describe('Markdown document worktree retention', () => {
  it('preserves recent under-limit worktrees and refreshes their LRU position', () => {
    let snapshots = new Map<string, MarkdownDocumentWorktreeSnapshot>()
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'a', documents('a'), {
      maxSnapshots: 2,
      maxRetainedBytes: 10_000
    })
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'b', documents('b'), {
      maxSnapshots: 2,
      maxRetainedBytes: 10_000
    })
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'a', documents('a-new'), {
      maxSnapshots: 2,
      maxRetainedBytes: 10_000
    })
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'c', documents('c'), {
      maxSnapshots: 2,
      maxRetainedBytes: 10_000
    })

    expect(Array.from(snapshots.keys())).toEqual(['a', 'c'])
    expect(snapshots.get('a')?.documents[0]?.name).toBe('a-new')
  })

  it('evicts oldest snapshots when their aggregate byte budget is exceeded', () => {
    let snapshots = new Map<string, MarkdownDocumentWorktreeSnapshot>()
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'a', documents('a'), {
      maxSnapshots: 10,
      maxRetainedBytes: 10_000
    })
    const oneSnapshotBytes = snapshots.get('a')?.retainedBytes ?? 0
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'b', documents('b'), {
      maxSnapshots: 10,
      maxRetainedBytes: oneSnapshotBytes
    })

    expect(Array.from(snapshots.keys())).toEqual(['b'])
  })
})
