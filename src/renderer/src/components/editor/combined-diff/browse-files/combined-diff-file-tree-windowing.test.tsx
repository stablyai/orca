// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS } from '@/components/right-sidebar/source-control/listing/virtual-file-list'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { CombinedDiffFileTreeRow as CombinedDiffFileTreeRowComponent } from './combined-diff-file-tree-row'

const mountedRows = vi.hoisted(() => ({ count: 0 }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ combinedDiffFileTreeWidth: 420, setCombinedDiffFileTreeWidth: () => {} })
}))

vi.mock('./combined-diff-file-tree-row', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    CombinedDiffFileTreeRow: typeof CombinedDiffFileTreeRowComponent
  }
  const react = await import('react')
  const Row = actual.CombinedDiffFileTreeRow
  const CountingRow = react.memo((props: React.ComponentProps<typeof Row>) => {
    react.useEffect(() => {
      mountedRows.count += 1
      return () => {
        mountedRows.count -= 1
      }
    }, [])
    return react.createElement(Row, props)
  })
  return { ...actual, CombinedDiffFileTreeRow: CountingRow }
})

const { CombinedDiffFileTree } = await import('./combined-diff-file-tree')
const { createCombinedDiffSectionIndexMap } =
  await import('../resolve-changes/combined-diff-section-identity')
const { getCombinedDiffBranchEntriesInTreeOrder } = await import('./combined-diff-file-tree-filter')

const VIEWPORT_HEIGHT_PX = 600
const TREE_ROW_HEIGHT_PX = 24
const EMPTY_VIEWED_KEYS: ReadonlySet<string> = new Set()

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  mountedRows.count = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains('overflow-auto') ? VIEWPORT_HEIGHT_PX : TREE_ROW_HEIGHT_PX
    }
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height = this.classList.contains('overflow-auto')
      ? VIEWPORT_HEIGHT_PX
      : TREE_ROW_HEIGHT_PX
    return {
      top: 0,
      bottom: height,
      height,
      left: 0,
      right: 240,
      width: 240,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** `fileCount` files spread over `directoryCount` directories, in the viewer's own tree order. */
function buildEntries(fileCount: number, directoryCount: number): GitBranchChangeEntry[] {
  const raw: GitBranchChangeEntry[] = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/dir${String(index % directoryCount).padStart(2, '0')}/file-${String(index).padStart(4, '0')}.ts`,
    status: 'modified'
  }))
  return getCombinedDiffBranchEntriesInTreeOrder('commit', raw)
}

function renderTree(entries: readonly GitBranchChangeEntry[]): void {
  const sectionIndexByKey = createCombinedDiffSectionIndexMap(
    entries.map((entry) => ({ key: `combined-commit:${entry.path}` }))
  )
  act(() => {
    root.render(
      <CombinedDiffFileTree
        mode="commit"
        worktreePath="/repo"
        entries={entries}
        sectionIndexByKey={sectionIndexByKey}
        activeSectionKey={null}
        viewedSectionKeys={EMPTY_VIEWED_KEYS}
        collapsed={false}
        onCollapsedChange={() => {}}
        onNavigate={() => {}}
      />
    )
  })
}

describe('combined diff file tree row windowing', () => {
  it('mounts every row below the virtualize threshold', () => {
    const fileCount = SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS - 10
    const directoryCount = 4
    renderTree(buildEntries(fileCount, directoryCount))

    // `src` plus one directory row per leaf directory, plus one row per file.
    const totalRows = 1 + directoryCount + fileCount
    expect(totalRows).toBeLessThan(SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS)
    expect(mountedRows.count).toBe(totalRows)
    expect(host.querySelector('[data-testid="source-control-virtual-list"]')).toBeNull()
    // Natural flow: no absolutely positioned wrappers, exactly the pre-virtualization markup.
    expect(host.querySelectorAll('[data-index]').length).toBe(0)
  })

  it('mounts only a window of rows for a large review', () => {
    const fileCount = 900
    const directoryCount = 30
    renderTree(buildEntries(fileCount, directoryCount))

    const totalRows = 1 + directoryCount + fileCount
    expect(host.querySelector('[data-testid="source-control-virtual-list"]')).not.toBeNull()
    expect(mountedRows.count).toBeGreaterThan(0)
    // A 600px viewport plus overscan: bounded by the window, not by the review size.
    expect(mountedRows.count).toBeLessThan(totalRows / 10)
  })
})
