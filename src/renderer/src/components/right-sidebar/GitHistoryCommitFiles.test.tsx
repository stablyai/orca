// @vitest-environment happy-dom

globalThis.IS_REACT_ACT_ENVIRONMENT = true

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GitHistoryCommitFiles,
  type GitHistoryCommitFilesState
} from './source-control/sync/git-history-commit-files'
import type { GitBranchChangeEntry } from '../../../../shared/git-diff-compare-types'
import type { SourceControlViewMode } from '../../../../shared/ui-chrome-types'

const KOTLIN_ADAPTER =
  'compensation/adapter/src/main/kotlin/com/karrotpay/fleamarket/compensation/adapter'

const ENTRIES: GitBranchChangeEntry[] = [
  { path: `${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`, status: 'added' },
  { path: `${KOTLIN_ADAPTER}/TargetIdResolverAdapter.kt`, status: 'renamed' }
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Mounts the panel for one commit in the given view mode and compaction setting. */
function render(
  viewMode: SourceControlViewMode,
  state: GitHistoryCommitFilesState = { status: 'ready', entries: ENTRIES },
  compactFolders = false
): void {
  act(() => {
    root.render(
      <GitHistoryCommitFiles
        state={state}
        viewMode={viewMode}
        compactFolders={compactFolders}
        onOpenFile={vi.fn()}
      />
    )
  })
}

/** The changed-file rows currently in the document. */
function fileRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="git-history-commit-file"]')]
}

/** The directory rows currently in the document; empty in list view. */
function directoryRows(): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-testid="git-history-commit-directory"]')
  ]
}

describe('GitHistoryCommitFiles', () => {
  describe('tree view', () => {
    it('renders one directory row per package segment', () => {
      render('tree')

      expect(directoryRows().map((row) => row.textContent?.trim())).toEqual([
        'compensation2',
        'adapter2',
        'src2',
        'main2',
        'kotlin2',
        'com2',
        'karrotpay2',
        'fleamarket2',
        'compensation2',
        'adapter2'
      ])
    })

    it('indents each file past its directory depth', () => {
      render('tree')

      // Base 36px + depth 10 * 12px.
      for (const row of fileRows()) {
        expect(row.style.paddingLeft).toBe('156px')
      }
    })

    it('drops the redundant directory hint from file rows', () => {
      render('tree')

      const row = fileRows()[0]
      expect(row.textContent).toContain('CompensationTargetQueryAdapter.kt')
      expect(row.textContent).not.toContain(KOTLIN_ADAPTER)
      // The full path stays reachable when the name truncates.
      expect(row.title).toBe(`${KOTLIN_ADAPTER}/CompensationTargetQueryAdapter.kt`)
    })

    it('hides descendants when a directory is collapsed and restores them on re-expand', () => {
      render('tree')
      const toggle = directoryRows()[0].querySelector('button')!

      act(() => toggle.click())
      expect(fileRows()).toHaveLength(0)
      expect(directoryRows()).toHaveLength(1)

      act(() => directoryRows()[0].querySelector('button')!.click())
      expect(fileRows()).toHaveLength(2)
      expect(directoryRows()).toHaveLength(10)
    })
  })

  describe('tree view with compact folders', () => {
    it('collapses the package chain into a single directory row', () => {
      render('tree', { status: 'ready', entries: ENTRIES }, true)

      const dirs = directoryRows()
      expect(dirs).toHaveLength(1)
      expect(dirs[0].textContent).toContain(KOTLIN_ADAPTER)
      // Depth 1 under the 36px base rather than the uncompacted depth 10.
      expect(fileRows()[0].style.paddingLeft).toBe('48px')
    })
  })

  describe('list view', () => {
    it('keeps the flat rows with their directory hint', () => {
      render('list')

      expect(directoryRows()).toHaveLength(0)
      const rows = fileRows()
      expect(rows).toHaveLength(2)
      expect(rows[0].textContent).toContain(KOTLIN_ADAPTER)
      expect(rows[0].className).toContain('pl-9')
      expect(rows[0].style.paddingLeft).toBe('')
    })
  })

  describe.each(['list', 'tree'] as const)('shared states (%s view)', (viewMode) => {
    it('renders the loading state', () => {
      render(viewMode, { status: 'loading' })

      expect(fileRows()).toHaveLength(0)
      expect(directoryRows()).toHaveLength(0)
      expect(container.textContent).toContain('Loading files')
    })

    it('renders the error state', () => {
      render(viewMode, { status: 'error', error: 'boom' })

      expect(container.textContent).toContain('boom')
    })

    it('renders the empty state', () => {
      render(viewMode, { status: 'ready', entries: [] })

      expect(fileRows()).toHaveLength(0)
      expect(directoryRows()).toHaveLength(0)
      expect(container.textContent).toContain('No file changes in this commit')
    })
  })
})
