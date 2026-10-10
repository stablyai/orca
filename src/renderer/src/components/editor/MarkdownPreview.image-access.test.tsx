// @vitest-environment happy-dom
//
// Renders the real MarkdownPreview and pins the file access its images are read with: a resource of the
// document showing them, so main limits them to that document's roots or folder.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useLocalImageSrcSpy = vi.hoisted(() => vi.fn((src?: string, ..._context: unknown[]) => src))

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
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: vi.fn(async () => ({ isDirectory: false }))
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => null }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  createConnectionIdForFileSelector: () => () => null
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: useLocalImageSrcSpy }))
vi.mock('./markdown-preview-local-images', () => ({
  prewarmMarkdownPreviewLocalImages: () => ({ cancel: () => {}, done: Promise.resolve() })
}))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))

import MarkdownPreview from './MarkdownPreview'

describe('MarkdownPreview images', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('api', {
      shell: { openUrl: vi.fn(), openFileUri: vi.fn(), pathExists: vi.fn(async () => true) },
      ui: { writeClipboardText: vi.fn(async () => true) }
    })
    useLocalImageSrcSpy.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  })

  it('reads each image as a resource of the document showing it', () => {
    act(() => {
      root.render(
        <MarkdownPreview
          content="![Logo](./logo.png)"
          filePath="/notes/readme.md"
          sourceWorktreeId="wt-1"
          scrollCacheKey="test-key"
        />
      )
    })

    expect(useLocalImageSrcSpy.mock.calls[0]?.[0]).toBe('./logo.png')
    expect(useLocalImageSrcSpy.mock.calls[0]?.[4]).toEqual({
      kind: 'document-resource',
      documentPath: '/notes/readme.md'
    })
  })
})
