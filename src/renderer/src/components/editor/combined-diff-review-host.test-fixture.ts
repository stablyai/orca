import React from 'react'
import { vi } from 'vitest'
import type * as VirtualBindings from '@tanstack/react-virtual'
import type { DiffSection } from './diff-section-types'
import { PRFilesCombinedDiffViewer as PageViewer } from '../pull-request-page/files/combined-diff-viewer'
import { PRFilesCombinedDiffViewer as DialogViewer } from '../github-item-dialog/inspect-pull-request/pr-files-combined-diff-viewer'

export const reviewHostFixture: {
  configureViewport?: (node: HTMLDivElement) => void
} = {}
export const reviewHostComponents = { page: PageViewer, dialog: DialogViewer }
export const originalContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
export const modifiedContent = originalContent.replace('line 10\n', 'changed\n')

type SectionSetter = React.Dispatch<React.SetStateAction<DiffSection[]>>
const loadSection = ({ index, setSections }: { index: number; setSections: SectionSetter }) =>
  setSections((prev) =>
    prev[index]?.loading
      ? prev.map((section, row) =>
          row === index ? { ...section, originalContent, modifiedContent, loading: false } : section
        )
      : prev
  )
vi.mock('@tanstack/react-virtual', async (importOriginal) => {
  const actual = await importOriginal<typeof VirtualBindings>()
  return {
    ...actual,
    useVirtualizer: (
      options: Parameters<typeof actual.useVirtualizer<HTMLDivElement, Element>>[0]
    ) =>
      actual.useVirtualizer({
        ...options,
        initialRect: { width: 1000, height: 300 },
        getScrollElement: () => {
          const node = options.getScrollElement()
          if (node) {
            reviewHostFixture.configureViewport?.(node)
          }
          return node
        }
      })
  }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: { theme: 'dark', diffWordWrap: true },
      editorFontZoomLevel: 0,
      worktreesByRepo: {},
      runtimeEnvironments: [],
      folderWorkspaces: []
    })
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/lib/monaco-setup', async () => ({
  monaco: await import('monaco-editor/esm/vs/editor/editor.api.js')
}))
vi.mock('../diff-comments/useDiffCommentDecorator', () => ({ useDiffCommentDecorator: () => {} }))
vi.mock('./combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: () => null
}))
vi.mock('../pull-request-page/files/toolbar', () => ({ PRFilesDiffToolbar: () => null }))
vi.mock('../github-item-dialog/inspect-pull-request/pr-files-combined-diff-toolbar', () => ({
  PRFilesCombinedDiffToolbar: () => null
}))
vi.mock('../pull-request-page/files/section-loader', () => ({
  usePRFileSectionLoader: ({ setSections }: { setSections: SectionSetter }) => ({
    loadSection: React.useCallback(
      (index: number) => loadSection({ index, setSections }),
      [setSections]
    ),
    retrySection: () => {},
    toggleSection: () => {},
    setAllSectionsCollapsed: () => {}
  })
}))
vi.mock('../github-item-dialog/inspect-pull-request/pr-files-combined-diff-load', () => ({
  loadPRFilesCombinedDiffSection: (args: Parameters<typeof loadSection>[0]) => loadSection(args),
  retryPRFilesCombinedDiffSection: () => {},
  togglePRFilesCombinedDiffSection: () => {},
  setAllPRFilesCombinedDiffSectionsCollapsed: () => {},
  addPRFilesCombinedDiffLineComment: () => Promise.resolve(false)
}))
