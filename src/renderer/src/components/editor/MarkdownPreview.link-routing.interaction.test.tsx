// @vitest-environment happy-dom
//
// Exercise real MarkdownPreview links, modifier detection and openHttpLink; control only store data and IPC.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { MarkdownPreviewSourceOpenFile } from './markdown-preview-types'

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
vi.mock('@/lib/file-owner-runtime-target', () => {
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
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useFileOwnerRuntimeTarget: (_worktreeId: unknown, runtimeEnvironmentId?: string | null) =>
    runtimeEnvironmentId
      ? { kind: 'environment', environmentId: runtimeEnvironmentId }
      : { kind: 'local' }
}))
vi.mock('@/runtime/runtime-file-metadata-client', () => ({ statRuntimePath: statRuntimePathMock }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: (worktreeId: string) => targetConnectionOwners.get(worktreeId)
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => connectionOwner.value
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'
import { buildOwnedEditorFileId } from '@/store/slices/editor/file-ids/editor-file-ids'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
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
      repos: [],
      endpointProjects: [],
      endpointProjectHostSetups: [],
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

  describe('file links with a #L line', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrameId = 0

    beforeEach(() => {
      frames.clear()
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        nextFrameId += 1
        frames.set(nextFrameId, callback)
        return nextFrameId
      })
      vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
        frames.delete(frameId)
      })
      const diffComments: never[] = []
      const sourceWorktree = { id: 'wt-1', path: '/repo', diffComments }
      const otherWorktree = { id: 'wt-2', path: '/other', diffComments }
      worktreeLookup.value = [sourceWorktree, otherWorktree]
      storeState.worktreesByRepo = { repo: [sourceWorktree], other: [otherWorktree] }
      targetConnectionOwners.set('wt-1', null)
      targetConnectionOwners.set('wt-2', null)
      storeState.openFile.mockReset()
      storeState.setPendingEditorReveal.mockClear()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      storeState.openFiles = []
      storeState.activeFileIdByWorktree = {}
    })

    function flushFrames(): void {
      // Map iteration also visits frames queued by the callbacks it runs.
      for (const [frameId, callback] of frames) {
        frames.delete(frameId)
        callback(0)
      }
    }

    async function clickLineLink(href: string): Promise<void> {
      const anchor = render(`[target](${href})`, href)
      await act(async () => {
        anchor.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }

    it('reveals the line in another worktree after the preview unmounts', async () => {
      const targetFileId = buildOwnedEditorFileId('/other/src/Example.cs', 'wt-2', null)
      // Use the real owner-qualified file ID so the editor can match and apply the reveal.
      storeState.openFile.mockImplementation(
        (file: { filePath: string; relativePath: string; worktreeId: string }) => {
          storeState.openFiles = [{ ...file, id: targetFileId, mode: 'edit' }]
          storeState.activeFileIdByWorktree = { [file.worktreeId]: targetFileId }
        }
      )
      await clickLineLink('file:///other/src/Example.cs#L120')
      // Worktree switching unmounts this preview before reveal frames execute.
      act(() => {
        root.unmount()
      })
      flushFrames()

      expect(storeState.openFile).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-2', filePath: '/other/src/Example.cs' })
      )
      expect(storeState.setPendingEditorReveal).toHaveBeenLastCalledWith(
        expect.objectContaining({
          fileId: targetFileId,
          filePath: '/other/src/Example.cs',
          line: 120,
          column: 1
        })
      )
    })

    it('reveals the line after replacing the preview in the same worktree', async () => {
      await clickLineLink('file:///repo/src/Example.cs#L42C7')
      act(() => {
        root.unmount()
      })
      flushFrames()

      expect(storeState.openFile).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: 'wt-1', filePath: '/repo/src/Example.cs' })
      )
      expect(storeState.setPendingEditorReveal).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: '/repo/src/Example.cs', line: 42, column: 7 })
      )
    })

    it('lets a newer editor navigation supersede the detached preview reveal', async () => {
      await clickLineLink('file:///other/src/Example.cs#L120')
      act(() => {
        root.unmount()
      })
      const successorId = buildOwnedEditorFileId('/repo/src/Newer.ts', 'wt-1', null)
      scheduleEditorLineReveal(useAppStore.getState, '/repo/src/Newer.ts', 75, 3, successorId)
      flushFrames()

      expect(storeState.setPendingEditorReveal.mock.calls).toEqual([
        [null],
        [null],
        [
          {
            filePath: '/repo/src/Newer.ts',
            fileId: successorId,
            line: 75,
            column: 3,
            matchLength: 0
          }
        ]
      ])
    })
  })
})
