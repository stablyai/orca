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

  it('retains at most 8 worktree snapshots by default', () => {
    // Why: the cases here pass explicit limits, which never exercise the shipped defaults. Asserted
    // against the literal ceiling so raising the constant fails rather than silently retaining more.
    let snapshots = new Map<string, MarkdownDocumentWorktreeSnapshot>()
    for (let index = 0; index < 12; index += 1) {
      snapshots = retainMarkdownDocumentWorktreeSnapshot(
        snapshots,
        `worktree-${index}`,
        documents(`doc-${index}`)
      )
    }

    expect(snapshots.size).toBe(8)
    expect(Array.from(snapshots.keys())).toEqual(
      Array.from({ length: 8 }, (_unused, index) => `worktree-${index + 4}`)
    )
  })

  it('caps aggregate retained bytes at 32 MiB by default', () => {
    // A single snapshot cannot exceed the 8 MiB per-listing ceiling, so the aggregate cap only
    // binds across several worktrees — which is exactly the case it exists for.
    const largeDocuments = Array.from({ length: 8_000 }, (_unused, index) => ({
      filePath: `/repo/${'nested/'.repeat(20)}doc-${index}.md`,
      relativePath: `${'nested/'.repeat(20)}doc-${index}.md`,
      basename: `doc-${index}.md`,
      name: `doc-${index}`
    }))

    let snapshots = new Map<string, MarkdownDocumentWorktreeSnapshot>()
    snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, 'w-0', largeDocuments)
    const perSnapshotBytes = snapshots.get('w-0')?.retainedBytes ?? 0
    // Five of these exceed 32 MiB while each stays under the per-listing ceiling.
    expect(perSnapshotBytes).toBeGreaterThan(6 * 1024 * 1024)

    for (let index = 1; index < 5; index += 1) {
      snapshots = retainMarkdownDocumentWorktreeSnapshot(snapshots, `w-${index}`, largeDocuments)
    }

    // Well under the 8-snapshot cap, so eviction here can only come from the byte ceiling.
    expect(snapshots.size).toBeLessThan(5)
    const retainedBytes = Array.from(snapshots.values()).reduce(
      (total, snapshot) => total + snapshot.retainedBytes,
      0
    )
    expect(retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
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
