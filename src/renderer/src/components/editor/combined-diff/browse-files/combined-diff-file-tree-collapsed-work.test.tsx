// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ combinedDiffFileTreeWidth: 420, setCombinedDiffFileTreeWidth: () => {} })
}))

const { CombinedDiffFileTree } = await import('./combined-diff-file-tree')

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Entries whose `path` getter counts reads. Every filter/group/flatten step the tree runs reads
 * `path`, so the count is a direct proxy for "did the tree get built".
 */
function countingEntries(count: number): {
  entries: GitBranchChangeEntry[]
  reads: () => number
} {
  let reads = 0
  const entries = Array.from({ length: count }, (_, index) => {
    const path = `src/dir${index % 5}/file-${index}.ts`
    const entry = { status: 'modified' } as GitBranchChangeEntry
    Object.defineProperty(entry, 'path', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1
        return path
      }
    })
    return entry
  })
  return { entries, reads: () => reads }
}

function renderTree(entries: GitBranchChangeEntry[], collapsed: boolean): void {
  act(() => {
    root.render(
      <CombinedDiffFileTree
        mode="branch"
        worktreePath="/repo"
        entries={entries}
        sectionIndexByKey={new Map()}
        activeSectionKey={null}
        viewedSectionKeys={new Set()}
        collapsed={collapsed}
        onCollapsedChange={() => {}}
        onNavigate={() => {}}
      />
    )
  })
}

describe('CombinedDiffFileTree while collapsed', () => {
  it('does not filter, build or flatten the tree behind a collapsed panel', () => {
    const { entries, reads } = countingEntries(300)

    renderTree(entries, true)

    expect(host.childElementCount).toBe(0)
    expect(reads()).toBe(0)
  })

  it('builds the same tree as soon as it is expanded', () => {
    const { entries, reads } = countingEntries(300)

    renderTree(entries, true)
    renderTree(entries, false)

    // Every entry is filtered and placed into the tree once the panel is visible.
    expect(reads()).toBeGreaterThanOrEqual(entries.length)
    expect(host.textContent).toContain('Files')
  })
})
