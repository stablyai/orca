import type * as WorktreeRuntimeOwnerIndex from '@/lib/workspace/ownership/worktree-runtime-owner-index'
// @vitest-environment happy-dom
//
// Exercise real MarkdownPreview links, modifier detection and openHttpLink; control only store data and IPC.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/index'
import type { MarkdownPreviewSourceOpenFile } from '../render-tree/markdown-preview-types'

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

const openFiles: MarkdownPreviewSourceOpenFile[] = []
const activeFileIdByWorktree: Record<string, string | null> = {}

// Provide only store reads used by this HTTP-link path; file actions should remain idle.
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
  openFiles,
  activeFileIdByWorktree,
  settings: { openLinksInApp: true },
  editorFontZoomLevel: 0
}

vi.mock('@/store/index', () => {
  const useAppStore = Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner-index', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeRuntimeOwnerIndex>()),
  findFirstIndexedWorktree: (_worktrees: unknown, id: string) =>
    worktreeLookup.value.find((worktree) => worktree.id === id) ?? null
}))
vi.mock('@/lib/files/access/file-owner-runtime-target', () => {
  const getRuntimeTargetForFileOwner = (
    _state: unknown,
    _worktreeId: string | null | undefined,
    owner: string | null | undefined
  ) => (owner ? { kind: 'environment' as const, environmentId: owner } : { kind: 'local' as const })
  return {
    FILE_OWNER_UNRESOLVED_MESSAGE: 'unresolved',
    getRuntimeTargetForFileOwner,
    requireRuntimeTargetForFileOwner: getRuntimeTargetForFileOwner,
    getRuntimeTargetForWorktreeOwner: (state: unknown, worktreeId: string | null | undefined) =>
      getRuntimeTargetForFileOwner(state, worktreeId, undefined)
  }
})
vi.mock('../../../../runtime/rpc/targets/use-worktree-runtime-target', () => ({
  useFileOwnerRuntimeTarget: (_worktreeId: unknown, runtimeEnvironmentId?: string | null) =>
    runtimeEnvironmentId
      ? { kind: 'environment', environmentId: runtimeEnvironmentId }
      : { kind: 'local' }
}))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  statRuntimePath: statRuntimePathMock
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) => targetConnectionOwners.get(worktreeId)
}))
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => connectionOwner.value
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../../document-images/useLocalImageSrc', () => ({
  useLocalImageSrc: (src?: string) => src
}))
vi.mock('../../diagrams/MermaidBlock', () => ({ default: () => null }))
vi.mock('../render-tree/CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../../../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('../../review-note-delivery/NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('../../markdown/navigation/MarkdownTableOfContentsPanel', () => ({
  MarkdownTableOfContentsPanel: () => null
}))

import MarkdownPreview from './MarkdownPreview'
import '@/store/slices/editor/focus/editor-focus-reveal'
import { registerHttpLinkStoreAccessor } from '../../../../lib/browser/navigation/http-link-routing'

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

  it('renders a raw HTML superscript citation', () => {
    const source = '<sup><a href="https://example.com">[12]</a></sup>'
    const anchor = render(source)

    expect(anchor.parentElement?.tagName).toBe('SUP')
    expect(anchor.textContent).toBe('[12]')
    expect(container.textContent).not.toContain('<sup>')
  })
})
