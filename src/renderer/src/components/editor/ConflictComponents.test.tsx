import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  ConflictBanner,
  ConflictReviewPanel,
  getNextConflictNavigationIndex
} from './ConflictComponents'

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
  it('renders unresolved conflicts as a left tree with supplied default content', () => {
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
        selectedContent={<div data-conflict-review-default-content="true">file contents</div>}
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
    expect(html).toContain('data-conflict-review-default-content="true"')
    expect(html).toContain('file contents')
    expect(html).not.toContain('Select a conflict from the file tree')
  })

  it('renders a lightweight overview when no conflict file is selected', () => {
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

    expect(html).toContain('Conflicts')
    expect(html).toContain('Open a file to resolve markers in the editor.')
    expect(html).toContain('Choose which version to keep, or combine them')
    expect(html).toContain('Resolve the conflict markers')
    expect(html).not.toContain('Loading conflict contents')
  })

  it('keeps selected conflict content in a flex-height pane', () => {
    const file = createConflictReviewFile()
    const html = renderToStaticMarkup(
      <ConflictReviewPanel
        file={file}
        liveEntries={[
          createLiveEntry('src/renderer/src/store/slices/linear.test.ts', 'added'),
          createLiveEntry('src/renderer/src/store/slices/linear.ts')
        ]}
        onOpenEntry={vi.fn()}
        selectedFile={{
          id: '/repo/src/renderer/src/store/slices/linear.ts',
          filePath: '/repo/src/renderer/src/store/slices/linear.ts',
          relativePath: 'src/renderer/src/store/slices/linear.ts',
          worktreeId: 'repo::/repo',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }}
        selectedContent={<div data-selected-conflict-content="true" className="flex-1" />}
        onDismiss={vi.fn()}
        onRefreshSnapshot={vi.fn()}
        onReturnToSourceControl={vi.fn()}
      />
    )

    expect(html).toContain(
      'class="flex min-h-0 flex-1 flex-col"><div data-selected-conflict-content="true"'
    )
  })
})

describe('ConflictBanner', () => {
  it('renders conflict navigation controls when conflict markers are available', () => {
    const file = createConflictReviewFile({
      mode: 'edit',
      conflict: {
        kind: 'conflict-editable',
        conflictKind: 'both_modified',
        conflictStatus: 'unresolved',
        conflictStatusSource: 'git'
      }
    })
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ConflictBanner
          file={file}
          entry={null}
          conflictNavigation={{
            currentIndex: 1,
            total: 3,
            onJump: vi.fn()
          }}
        />
      </TooltipProvider>
    )

    expect(html).toContain('Unresolved conflict')
    expect(html).toContain('2 / 3')
    expect(html).toContain('Previous conflict')
    expect(html).toContain('Next conflict')
  })
})

describe('getNextConflictNavigationIndex', () => {
  it('cycles through conflicts in both directions', () => {
    expect(
      getNextConflictNavigationIndex({ currentIndex: null, direction: 'next', total: 3 })
    ).toBe(0)
    expect(getNextConflictNavigationIndex({ currentIndex: 2, direction: 'next', total: 3 })).toBe(0)
    expect(
      getNextConflictNavigationIndex({ currentIndex: 0, direction: 'previous', total: 3 })
    ).toBe(2)
    expect(
      getNextConflictNavigationIndex({ currentIndex: null, direction: 'previous', total: 3 })
    ).toBe(2)
    expect(getNextConflictNavigationIndex({ currentIndex: 0, direction: 'next', total: 0 })).toBe(
      null
    )
  })
})
