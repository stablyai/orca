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

vi.mock('./pr-files-combined-diff-body', () => ({
  PRFilesCombinedDiffBody: (props: {
    sectionIndexByKey: ReadonlyMap<string, number>
    loadSection: (index: number) => void
  }) => {
    capturedSectionIndexMaps.list.push(props.sectionIndexByKey)
    loaders.loadSection = props.loadSection
    return null
  }
}))

vi.mock('./pr-files-combined-diff-load', () => ({
  addPRFilesCombinedDiffLineComment: () => Promise.resolve(),
  // Why: stands in for the network fetch, keeping only the state shape a real load produces —
  // a new sections array with one patched section and untouched keys.
  loadPRFilesCombinedDiffSection: ({
    index,
    setSections
  }: {
    index: number
    setSections: (updater: (prev: { key: string; loading: boolean }[]) => unknown) => void
  }) => {
    setSections((prev) =>
      prev.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, loading: false } : section
      )
    )
  },
  retryPRFilesCombinedDiffSection: () => {},
  setAllPRFilesCombinedDiffSectionsCollapsed: () => {},
  togglePRFilesCombinedDiffSection: () => {}
}))

const { PRFilesCombinedDiffViewer } = await import('./pr-files-combined-diff-viewer')

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

describe('inspect-pull-request combined diff section index map', () => {
  it('keeps one map identity across on-demand section loads', () => {
    act(() => {
      root.render(<PRFilesCombinedDiffViewer {...viewerProps} />)
    })
    const initialMap = capturedSectionIndexMaps.list.at(-1)
    expect(initialMap?.size).toBe(viewerProps.files.length)

    for (let index = 0; index < viewerProps.files.length; index += 1) {
      act(() => loaders.loadSection(index))
    }

    expect(capturedSectionIndexMaps.list.length).toBeGreaterThan(viewerProps.files.length)
    expect(new Set(capturedSectionIndexMaps.list).size).toBe(1)
  })
})
