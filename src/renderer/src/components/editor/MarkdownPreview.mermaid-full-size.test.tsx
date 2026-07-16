// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
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
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => null
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="mermaid-block">{content}</div>
}))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="code-block-copy">{children}</div>
  )
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'

const DOC = [
  '```mermaid',
  'flowchart LR',
  'A[Start] --> B{Decision}',
  'B -->|yes| C[Ship]',
  'B -->|no| D[Retry]',
  '```',
  '',
  '```ts',
  "console.log('keep pre route')",
  '```'
].join('\n')

describe('MarkdownPreview Mermaid full-size affordance', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: { openUrl: vi.fn(), openFileUri: vi.fn(), pathExists: vi.fn(async () => true) },
      ui: { writeClipboardText: vi.fn(async () => true) }
    }
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

  function render(): void {
    act(() => {
      root.render(
        <MarkdownPreview
          content={DOC}
          filePath="/repo/docs/README.md"
          sourceWorktreeId="wt-1"
          scrollCacheKey="test-key"
        />
      )
    })
  }

  it('keeps Mermaid outside pre and leaves normal code in the copy route', () => {
    render()

    const mermaid = container.querySelector('[data-testid="mermaid-block"]')
    expect(mermaid).not.toBeNull()
    expect(mermaid?.closest('pre')).toBeNull()

    const codeBlocks = Array.from(container.querySelectorAll('[data-testid="code-block-copy"]'))
    expect(codeBlocks.length).toBeGreaterThan(0)
    expect(
      codeBlocks.some((block) => block.textContent?.includes("console.log('keep pre route')"))
    ).toBe(true)
    expect(container.querySelectorAll('button[aria-label="Open full size"]')).toHaveLength(1)
  })

  it('opens a dialog with the same Mermaid source', () => {
    render()

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open full size"]'
    )
    expect(trigger).not.toBeNull()

    act(() => {
      trigger?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    const dialog = document.body.querySelector('[data-slot="dialog-content"]')
    expect(dialog).not.toBeNull()
    expect(document.body.querySelectorAll('[data-testid="mermaid-block"]')).toHaveLength(2)
    expect(dialog?.textContent).toContain('flowchart LR')
  })
})
