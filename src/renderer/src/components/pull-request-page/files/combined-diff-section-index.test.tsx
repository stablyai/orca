// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { PRFilesCombinedDiffViewerProps } from '@/components/github/pr-file-diff-mapping'

const capturedSectionIndexMaps = vi.hoisted(() => ({ list: [] as ReadonlyMap<string, number>[] }))
const loaders = vi.hoisted(() => ({ loadSection: (_index: number) => {} }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: { theme: 'dark' } })
}))

vi.mock('../../editor/combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: (props: { sectionIndexByKey: ReadonlyMap<string, number> }) => {
    capturedSectionIndexMaps.list.push(props.sectionIndexByKey)
    return null
  }
}))

vi.mock('@/components/editor/DiffSectionItem', () => ({ DiffSectionItem: () => null }))
vi.mock('./toolbar', () => ({ PRFilesDiffToolbar: () => null }))
vi.mock('./view-restore', () => ({ usePRFilesDiffViewPersistence: () => {} }))

vi.mock('./section-loader', () => ({
  usePRFileSectionLoader: ({
    setSections
  }: {
    setSections: (updater: (prev: { key: string; loading: boolean }[]) => unknown) => void
  }) => {
    // Why: stands in for the network fetch, keeping only the state shape a real load produces —
    // a new sections array with one patched section and untouched keys.
    loaders.loadSection = (index: number) => {
      setSections((prev) =>
        prev.map((section, sectionIndex) =>
          sectionIndex === index ? { ...section, loading: false } : section
        )
      )
    }
    return {
      loadSection: loaders.loadSection,
      retrySection: () => {},
      toggleSection: () => {},
      setAllSectionsCollapsed: () => {}
    }
  }
}))

const { PRFilesCombinedDiffViewer } = await import('./combined-diff-viewer')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  capturedSectionIndexMaps.list = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function prFiles(count: number): GitHubPRFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${String(index).padStart(3, '0')}.ts`,
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    isBinary: false
  }))
}

const viewerProps: PRFilesCombinedDiffViewerProps = {
  files: prFiles(6),
  comments: [],
  repoPath: '/repo',
  repoId: 'repo-1',
  prNumber: 7,
  prUrl: 'https://example.test/pr/7',
  headSha: 'head',
  baseSha: 'base',
  pendingViewedPaths: new Set(),
  onCommentAdded: () => {},
  onViewedChange: () => Promise.resolve(true)
}

describe('pull request page combined diff section index map', () => {
  it('keeps one map identity across on-demand section loads', () => {
    act(() => {
      root.render(<PRFilesCombinedDiffViewer {...viewerProps} />)
    })
    capturedSectionIndexMaps.list = []

    for (let index = 0; index < viewerProps.files.length; index += 1) {
      act(() => loaders.loadSection(index))
    }

    expect(capturedSectionIndexMaps.list.length).toBe(viewerProps.files.length)
    expect(capturedSectionIndexMaps.list[0]?.size).toBe(viewerProps.files.length)
    expect(new Set(capturedSectionIndexMaps.list).size).toBe(1)
  })
})
