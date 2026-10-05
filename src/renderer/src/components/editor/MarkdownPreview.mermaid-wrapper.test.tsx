// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writeClipboardText = vi.fn(async () => true)
const state = {
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
  settings: { openLinksInApp: true },
  editorFontZoomLevel: 0
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: () => ({ id: 'fixture', path: '/fixture', diffComments: [] })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (settings: unknown) => settings
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => null
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({
  default: ({ content }: { content: string }) =>
    content.startsWith('invalid') ? (
      <div className="mermaid-block">
        <div className="mermaid-error">Diagram error</div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    ) : (
      <div className="mermaid-block">
        <svg viewBox="0 0 128 1946">
          <text>{content}</text>
        </svg>
      </div>
    )
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'

describe('MarkdownPreview Mermaid wrapper', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  function render(content: string): void {
    act(() =>
      root.render(
        <MarkdownPreview
          content={content}
          filePath="/fixture/diagram.md"
          sourceWorktreeId="fixture"
          scrollCacheKey="mermaid-wrapper"
          markdownAnnotationsEnabled
        />
      )
    )
  }
  it('renders the mapped Mermaid component outside the code pre while retaining its annotation range', () => {
    render('```mermaid\nflowchart TD; A --> B\n```')
    const diagram = container.querySelector('.mermaid-block svg')
    expect(diagram?.textContent).toBe('flowchart TD; A --> B')
    expect(diagram?.closest('pre')).toBeNull()
    const annotation = diagram?.closest('.markdown-annotation-block')
    expect(annotation?.getAttribute('data-source-line')).toBe('1')
    expect(annotation?.getAttribute('data-source-end-line')).toBe('3')
    expect(annotation?.querySelector('button[aria-label="Add note"]')).not.toBeNull()
    expect(container.querySelector('.code-block-copy-btn')).not.toBeNull()
  })
  it('copies the authored Mermaid source through clipboard IPC', async () => {
    render('```mermaid\nflowchart TD; A --> B\n```')
    const button = container.querySelector<HTMLButtonElement>('.code-block-copy-btn')
    if (!button) {
      throw new Error('Missing diagram copy button')
    }
    await act(async () => button.click())
    expect(writeClipboardText).toHaveBeenLastCalledWith('flowchart TD; A --> B\n')
  })
  it('keeps ordinary code in its copyable pre with its annotation range', () => {
    render('```typescript\nconst diagram = "mermaid"\n```')
    const code = container.querySelector('pre code')
    expect(code?.textContent).toBe('const diagram = "mermaid"\n')
    expect(code?.closest('.markdown-annotation-block')?.getAttribute('data-source-line')).toBe('1')
    expect(container.querySelector('.code-block-copy-btn')).not.toBeNull()
    expect(container.querySelector('.mermaid-block')).toBeNull()
  })
  it('retains invalid diagram source in the diagram error fallback and keeps it copyable', async () => {
    render('```mermaid\ninvalid diagram\n```')
    expect(container.querySelector('.mermaid-error')?.textContent).toBe('Diagram error')
    expect(container.querySelector('pre code')?.textContent).toBe('invalid diagram')
    const button = container.querySelector<HTMLButtonElement>('.code-block-copy-btn')
    if (!button) {
      throw new Error('Missing invalid diagram copy button')
    }
    await act(async () => button.click())
    expect(writeClipboardText).toHaveBeenLastCalledWith('invalid diagram\n')
  })
  it('keeps inline Mermaid-looking code literal', () => {
    render('Literal `mermaid` and `<svg>`')
    expect(container.querySelector('.mermaid-block')).toBeNull()
    expect([...container.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'mermaid',
      '<svg>'
    ])
  })
})
