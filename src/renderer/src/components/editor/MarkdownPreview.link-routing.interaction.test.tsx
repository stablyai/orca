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
const openFileUriMock = vi.fn()
const pathExistsMock = vi.fn(async () => true)
const connectionOwner = vi.hoisted(() => ({ value: null as string | null | undefined }))
const targetConnectionOwners = vi.hoisted(() => new Map<string, string | null | undefined>())
const worktreeLookup = vi.hoisted(() => ({
  value: [] as { id: string; path: string; diffComments: never[] }[]
}))
const statRuntimePathMock = vi.hoisted(() => vi.fn(async () => ({ isDirectory: false })))

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
vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: (_worktrees: unknown, id: string) =>
    worktreeLookup.value.find((worktree) => worktree.id === id) ?? null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (settings: unknown) => settings
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: statRuntimePathMock
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) => targetConnectionOwners.get(worktreeId)
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => connectionOwner.value
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
        openFileUri: openFileUriMock,
        pathExists: pathExistsMock
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
    openFileUriMock.mockClear()
    pathExistsMock.mockClear()
    connectionOwner.value = null
    targetConnectionOwners.clear()
    worktreeLookup.value = []
    storeState.worktreesByRepo = {}
    storeState.openMarkdownPreview.mockClear()
    statRuntimePathMock.mockClear()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function render(
    content = '[example](https://example.com)',
    expectedHref = 'https://example.com',
    sourceWorktreeId = 'wt-1',
    filePath = '/repo/docs/README.md'
  ): HTMLAnchorElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <MarkdownPreview
          content={content}
          filePath={filePath}
          sourceWorktreeId={sourceWorktreeId}
          scrollCacheKey="test-key"
        />
      )
    })
    const anchor = Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).find(
      (candidate) => candidate.getAttribute('href') === expectedHref
    )
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

  it('keeps system-browser HTTP and file links inert while ownership is unknown', () => {
    connectionOwner.value = undefined
    const httpAnchor = render()
    click(httpAnchor, { metaKey: true, shiftKey: true })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()

    act(() => {
      root.unmount()
    })
    container.remove()
    const fileAnchor = render('[file](file:///tmp/example.md)', 'file:///tmp/example.md')
    click(fileAnchor, { metaKey: true, shiftKey: true })
    expect(pathExistsMock).not.toHaveBeenCalled()
    expect(openFileUriMock).not.toHaveBeenCalled()
  })

  it('keeps same-path file links on the explicit SSH source worktree', async () => {
    const localWorktree = { id: 'local-wt', path: '/srv/repo', diffComments: [] as never[] }
    const sshWorktree = { id: 'ssh-wt', path: '/srv/repo', diffComments: [] as never[] }
    worktreeLookup.value = [localWorktree, sshWorktree]
    storeState.worktreesByRepo = { repo: [localWorktree, sshWorktree] }
    connectionOwner.value = 'ssh-1'
    targetConnectionOwners.set('local-wt', null)
    targetConnectionOwners.set('ssh-wt', 'ssh-1')
    const anchor = render('[child](child.md)', 'child.md', 'ssh-wt', '/srv/repo/README.md')

    await act(async () => {
      anchor.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(statRuntimePathMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'ssh-wt', connectionId: 'ssh-1' }),
      '/srv/repo/child.md'
    )
    expect(storeState.openMarkdownPreview).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'ssh-wt', filePath: '/srv/repo/child.md' }),
      { anchor: null }
    )
  })

  it('renders a raw HTML superscript citation and routes it like a Markdown link', () => {
    const source = '<sup><a href="https://example.com">[12]</a></sup>'
    const anchor = render(source)

    expect(anchor.parentElement?.tagName).toBe('SUP')
    expect(anchor.textContent).toBe('[12]')
    expect(container.textContent).not.toContain('<sup>')
    click(anchor, { metaKey: true })
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})
