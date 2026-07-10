// @vitest-environment happy-dom
//
// Faithful end-to-end check of the markdown-preview http link routing: renders
// the real MarkdownPreview, lets react-markdown produce a real <a>, and fires
// real modifier clicks so the component's own handleClick + modifier detection
// run. openHttpLink stays real (wired through its registerHttpLinkStoreAccessor
// seam); only its store data and window.api are controlled. This is the
// regression guard for "Cmd+Shift-click opens the system browser, plain/Cmd
// click opens the Orca browser".

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const createBrowserTabMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const openUrlMock = vi.fn()

// Minimal store: MarkdownPreview reads settings/worktreesByRepo plus a handful
// of action functions. None of the actions fire on the http path under test.
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
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'
import { registerHttpLinkStoreAccessor } from '../../lib/http-link-routing'

describe('MarkdownPreview http link routing (Cmd vs Cmd+Shift click)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: {
        openUrl: openUrlMock,
        openFileUri: vi.fn(),
        pathExists: vi.fn(async () => true)
      },
      ui: { writeClipboardText: vi.fn(async () => true) }
    }
    // openHttpLink reads the store through this injected accessor, not @/store.
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: true, activeRuntimeEnvironmentId: null },
      setActiveWorktree: setActiveWorktreeMock,
      createBrowserTab: createBrowserTabMock
    }))
    createBrowserTabMock.mockClear()
    setActiveWorktreeMock.mockClear()
    openUrlMock.mockClear()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function render(): HTMLAnchorElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <MarkdownPreview
          content="[example](https://example.com)"
          filePath="/repo/docs/README.md"
          sourceWorktreeId="wt-1"
          scrollCacheKey="test-key"
        />
      )
    })
    const anchor = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')
    if (!anchor) {
      throw new Error('expected a rendered http anchor')
    }
    return anchor
  }

  function click(anchor: HTMLAnchorElement, modifiers: Partial<MouseEventInit>): void {
    act(() => {
      anchor.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })
      )
    })
  }

  it('plain Cmd-click opens the link in the Orca browser', () => {
    const anchor = render()
    click(anchor, { metaKey: true })
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('Cmd+Shift-click opens the link in the system default browser', () => {
    const anchor = render()
    click(anchor, { metaKey: true, shiftKey: true })
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
