import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/types'
import { ConflictReviewPanel } from './ConflictComponents'

function createConflictReviewFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'repo::/repo::conflict-review',
    filePath: '/repo',
    relativePath: 'Conflict Review',
    worktreeId: 'repo::/repo',
    language: 'text',
    isDirty: false,
    mode: 'conflict-review',
    conflictReview: {
      source: 'live-summary',
      snapshotTimestamp: Date.UTC(2026, 4, 17, 19, 9, 7),
      entries: [
        {
          path: 'src/renderer/src/store/slices/linear.test.ts',
          conflictKind: 'both_added'
        },
        {
          path: 'src/renderer/src/store/slices/linear.ts',
          conflictKind: 'both_modified'
        }
      ]
    },
    ...overrides
  }
}

function createLiveEntry(
  path: string,
  status: GitStatusEntry['status'] = 'modified'
): GitStatusEntry {
  return {
    path,
    status,
    area: 'unstaged',
    conflictKind: path.endsWith('.test.ts') ? 'both_added' : 'both_modified',
    conflictStatus: 'unresolved',
    conflictStatusSource: 'git'
  }
}

describe('ConflictReviewPanel', () => {
  it('renders unresolved conflicts as a left file tree', () => {
    const file = createConflictReviewFile()
    const html = renderToStaticMarkup(
      <ConflictReviewPanel
        file={file}
        liveEntries={[
          createLiveEntry('src/renderer/src/store/slices/linear.test.ts', 'added'),
          createLiveEntry('src/renderer/src/store/slices/linear.ts')
        ]}
        onOpenEntry={vi.fn()}
        selectedFile={null}
        selectedContent={null}
        onDismiss={vi.fn()}
        onRefreshSnapshot={vi.fn()}
        onReturnToSourceControl={vi.fn()}
      />
    )

    expect(html).toContain('Files')
    expect(html).toContain('Collapse file tree')
    expect(html).toContain('src/renderer/src/store/slices')
    expect(html).toContain('linear.test.ts')
    expect(html).toContain('linear.ts')
    expect(html).toContain('Select a conflict from the file tree')
    expect(html).not.toContain('Choose which version to keep, or combine them')
  })
})
