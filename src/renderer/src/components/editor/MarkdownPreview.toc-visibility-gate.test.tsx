// @vitest-environment happy-dom
//
// Regression guard for the follow-up to #6695: MarkdownPreview must route its
// Table-of-Contents build through the visibility gate, so the full-document
// remark parse only runs while the panel is open (closed by default). This
// renders the real MarkdownPreview and asserts the parse is skipped when closed
// and a real outline reaches the panel when open. The gate's own semantics are
// unit-tested in markdown-toc-visibility-gate.test.ts; this proves the wiring.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MarkdownTocItem } from './markdown-table-of-contents'
import type * as MarkdownTableOfContentsModule from './markdown-table-of-contents'

const buildMarkdownTableOfContentsSpy = vi.hoisted(() => vi.fn())

const storeState = {
  openFile: vi.fn(),
  activateMarkdownLink: vi.fn(),
  openMarkdownPreview: vi.fn(),
  setMarkdownViewMode: vi.fn(),
  markdownFrontmatterVisible: {},
  setPendingEditorReveal: vi.fn(),
  addDiffComment: vi.fn(),
  deleteDiffComment: vi.fn(),
  updateDiffComment: vi.fn(),
  clearDeliveredDiffComments: vi.fn(),
  keybindings: {},
  worktreesByRepo: {},
  openFiles: [],
  activeFileIdByWorktree: {},
  settings: { openLinksInApp: true },
  editorFontZoomLevel: 0
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})
vi.mock('@/store/slices/worktree-helpers', () => ({ findWorktreeById: () => null }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (settings: unknown) => settings
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: vi.fn(async () => ({ isDirectory: false }))
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
// Render the items the gate produced so the test can read the outline from the DOM.
vi.mock('./MarkdownTableOfContentsPanel', () => ({
  MarkdownTableOfContentsPanel: ({ items }: { items: MarkdownTocItem[] }) => (
    <nav aria-label="toc-spy">{items.map((item) => item.title).join('|')}</nav>
  )
}))
// Spy on the expensive parse without changing its behavior, so the test can
// assert it is never invoked while the panel is closed.
vi.mock('./markdown-table-of-contents', async (importOriginal) => {
  const actual = await importOriginal<typeof MarkdownTableOfContentsModule>()
  buildMarkdownTableOfContentsSpy.mockImplementation(actual.buildMarkdownTableOfContents)
  return { ...actual, buildMarkdownTableOfContents: buildMarkdownTableOfContentsSpy }
})

import MarkdownPreview from './MarkdownPreview'

const DOC = '# Intro\n\n## Setup\n\n## Usage'

describe('MarkdownPreview TOC visibility gate', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: { openUrl: vi.fn(), openFileUri: vi.fn(), pathExists: vi.fn(async () => true) },
      ui: { writeClipboardText: vi.fn(async () => true) }
    }
    buildMarkdownTableOfContentsSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function render(showTableOfContents: boolean): void {
    act(() => {
      root.render(
        <MarkdownPreview
          content={DOC}
          filePath="/repo/docs/README.md"
          sourceWorktreeId="wt-1"
          scrollCacheKey="test-key"
          showTableOfContents={showTableOfContents}
        />
      )
    })
  }

  it('skips the full-document parse and renders no panel while the panel is closed', () => {
    render(false)
    expect(buildMarkdownTableOfContentsSpy).not.toHaveBeenCalled()
    expect(container.querySelector('nav[aria-label="toc-spy"]')).toBeNull()
  })

  it('builds and shows the outline when the panel is open', () => {
    render(true)
    expect(buildMarkdownTableOfContentsSpy).toHaveBeenCalledWith(DOC)
    expect(container.querySelector('nav[aria-label="toc-spy"]')?.textContent).toBe('Intro')
  })
})
