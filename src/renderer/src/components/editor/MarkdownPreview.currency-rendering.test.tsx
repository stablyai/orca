// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  repos: [],
  folderWorkspaces: [],
  projectGroups: [],
  openFiles: [],
  activeFileIdByWorktree: {},
  settings: null,
  editorFontZoomLevel: 0
}

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
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
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => null
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ISSUE_MARKDOWN =
  '月成本 **$148+ → $19**（省 **87%**，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'
const ISSUE_TEXT = '月成本 $148+ → $19（省 87%，年省 ~$1,550）；后续释放老 EIP 可再降到 $15.4/月'

function extractRenderedText(root: Node): string {
  if (root instanceof HTMLElement && root.getAttribute('aria-hidden') === 'true') {
    return ''
  }
  if (root instanceof Element && root.localName === 'math') {
    return ''
  }
  if (root.nodeType === Node.TEXT_NODE) {
    return root.textContent ?? ''
  }
  return Array.from(root.childNodes, extractRenderedText).join('')
}

describe('MarkdownPreview currency rendering', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ;(window as unknown as { api: unknown }).api = {
      ui: { writeClipboardText: vi.fn(async () => true) }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderPreview(content: string): HTMLElement {
    act(() => {
      root.render(
        <MarkdownPreview content={content} filePath="/repo/README.md" scrollCacheKey="test" />
      )
    })
    const body = container.querySelector<HTMLElement>('.markdown-body')
    if (!body) {
      throw new Error('expected rendered markdown body')
    }
    return body
  }

  it('keeps the reported currency string in rendered and extracted text', () => {
    const body = renderPreview(ISSUE_MARKDOWN)

    expect(extractRenderedText(body)).toBe(ISSUE_TEXT)
    expect(body.textContent).toBe(ISSUE_TEXT)
    expect(body.querySelector('.katex')).toBeNull()
  })

  it('continues to render double-dollar display math with KaTeX', () => {
    const body = renderPreview('$$\nE=mc^2\n$$')

    expect(body.querySelector('.katex-display')).not.toBeNull()
  })
})
