// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  decodeMarkdownPreviewAnchor,
  deriveMarkdownPreviewSourceRoot,
  getMarkdownPreviewSourceRelativePath,
  findMarkdownPreviewOpenedEditFileId,
  findMarkdownPreviewSourceOpenFile,
  getMarkdownPreviewAnchorScrollTop,
  resolveMarkdownPreviewSourceWorktree
} from './MarkdownPreview'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

// Additional tests for markdownPreviewLightBackground flag (per plan for issue #1).
// We render the real MarkdownPreview to verify the class applied to the preview
// container is controlled by the flag (light forced) vs app theme.

// Mocks must be hoisted before any imports that use them.
vi.mock('@/store', () => {
  const useAppStore = vi.fn()
  return { useAppStore }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: (s: unknown) => s
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: vi.fn(async () => ({ isDirectory: false }))
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/i18n/i18n', () => ({ translate: (_k: string, fb: string) => fb }))
vi.mock('./useLocalImageSrc', () => ({ useLocalImageSrc: (src?: string) => src }))
vi.mock('./MermaidBlock', () => ({ default: () => null }))
vi.mock('./CodeBlockCopyButton', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('../diff-comments/DiffCommentCard', () => ({ DiffCommentCard: () => null }))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))
vi.mock('./MarkdownTableOfContentsPanel', () => ({ MarkdownTableOfContentsPanel: () => null }))
vi.mock('./usePreserveSectionDuringExternalEdit', () => ({
  usePreserveSectionDuringExternalEdit: (c: string) => c
}))

import MarkdownPreview from './MarkdownPreview'
import { useAppStore } from '@/store'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as React from 'react'

function makeWorktree(id: string, path: string): Worktree {
  return {
    id,
    repoId: `repo-${id}`,
    path,
    branch: 'refs/heads/main',
    head: 'abc',
    isBare: false,
    isMainWorktree: true,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

describe('MarkdownPreview source link routing', () => {
  it('falls back to the raw anchor when percent-decoding fails', () => {
    expect(decodeMarkdownPreviewAnchor('%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('keeps the explicit source worktree when it exists', () => {
    const source = makeWorktree('wt-source', '/repo')
    const nested = makeWorktree('wt-nested', '/repo/packages/app')

    expect(
      resolveMarkdownPreviewSourceWorktree(
        { repo: [source, nested] },
        'wt-source',
        '/repo/packages/app/docs/note.md'
      )
    ).toBe(source)
  })

  it('falls back to path-based repo ownership for repo-contained floating files', () => {
    const repoWorktree = makeWorktree('wt-repo', '/repo')

    expect(
      resolveMarkdownPreviewSourceWorktree(
        { repo: [repoWorktree] },
        FLOATING_TERMINAL_WORKTREE_ID,
        '/repo/docs/note.md'
      )
    ).toBe(repoWorktree)
  })

  it('matches Windows worktree ownership case-insensitively for floating previews', () => {
    const repoWorktree = makeWorktree('wt-repo', 'C:\\Repo')

    expect(
      resolveMarkdownPreviewSourceWorktree(
        { repo: [repoWorktree] },
        FLOATING_TERMINAL_WORKTREE_ID,
        'c:\\repo\\docs\\note.md'
      )
    ).toBe(repoWorktree)
  })

  it('derives Windows preview source relative paths case-insensitively', () => {
    expect(getMarkdownPreviewSourceRelativePath('c:\\repo\\docs\\note.md', 'C:\\Repo')).toBe(
      'docs/note.md'
    )
  })

  it('derives a source root from floating file relative path', () => {
    expect(deriveMarkdownPreviewSourceRoot('/tmp/orca/docs/note.md', 'docs/note.md')).toBe(
      '/tmp/orca'
    )
  })

  it('falls back to the source file directory when no relative path is available', () => {
    expect(deriveMarkdownPreviewSourceRoot('/tmp/orca/docs/note.md', null)).toBe('/tmp/orca/docs')
  })

  it('derives Windows source roots without dropping the drive separator', () => {
    expect(deriveMarkdownPreviewSourceRoot('C:\\orca\\docs\\note.md', 'docs\\note.md')).toBe(
      'C:/orca'
    )
  })

  it('falls back to the matching preview tab for preview-only source metadata', () => {
    const otherOwnerEdit = {
      id: '/tmp/orca/docs/note.md',
      filePath: '/tmp/orca/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: 'wt-1',
      mode: 'edit'
    }
    const preview = {
      id: 'markdown-preview::/tmp/orca/docs/note.md',
      filePath: '/tmp/orca/docs/note.md',
      relativePath: 'docs/note.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: '/tmp/orca/docs/note.md'
    }

    expect(
      findMarkdownPreviewSourceOpenFile([otherOwnerEdit, preview], {
        sourceFileId: '/tmp/orca/docs/note.md',
        filePath: '/tmp/orca/docs/note.md',
        sourceWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        sourceRuntimeEnvironmentId: null
      })
    ).toBe(preview)
    expect(deriveMarkdownPreviewSourceRoot(preview.filePath, preview.relativePath)).toBe(
      '/tmp/orca'
    )
  })

  it('uses the edit tab that openFile actually activated for line reveals', () => {
    const localEdit = {
      id: '/repo/docs/guide.md',
      filePath: '/repo/docs/guide.md',
      relativePath: 'docs/guide.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      mode: 'edit'
    }
    const activeRuntimeEdit = {
      id: 'editor:wt-1:env-active:guide',
      filePath: '/repo/docs/guide.md',
      relativePath: 'docs/guide.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-active',
      mode: 'edit'
    }

    expect(
      findMarkdownPreviewOpenedEditFileId(
        [localEdit, activeRuntimeEdit],
        {
          'wt-1': activeRuntimeEdit.id
        },
        {
          filePath: '/repo/docs/guide.md',
          worktreeId: 'wt-1'
        }
      )
    ).toBe(activeRuntimeEdit.id)
  })

  it('computes anchor scroll from viewport position instead of offset parent', () => {
    const container = {
      scrollTop: 125,
      getBoundingClientRect: () => ({ top: 50 }) as DOMRect
    }
    const target = {
      getBoundingClientRect: () => ({ top: 430 }) as DOMRect
    }

    expect(getMarkdownPreviewAnchorScrollTop(container, target)).toBe(493)
  })
})

// --- markdownPreviewLightBackground flag + isolated class tests ---

const mockSettingsBase = {
  theme: 'dark' as const,
  markdownPreviewLightBackground: false
}

let containerEl: HTMLDivElement
let root: Root | null = null

function setupStore(
  overrides: { markdownPreviewLightBackground?: boolean; theme?: 'dark' | 'light' | 'system' } = {}
) {
  const settings = { ...mockSettingsBase, ...overrides }
  const storeState = {
    settings,
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
    editorFontZoomLevel: 0
  }
  // Store fixture is intentionally partial (only fields this component reads),
  // so the mock is typed against `unknown` rather than the full AppState shape.
  const mockedUseAppStore = useAppStore as unknown as Mock<
    (selector: (state: unknown) => unknown) => unknown
  >
  mockedUseAppStore.mockImplementation((selector) => selector(storeState))
  // also support getState if used
  Object.assign(useAppStore, { getState: () => storeState })
  return storeState
}

describe('MarkdownPreview light background flag (isolated surface)', () => {
  beforeEach(() => {
    containerEl = document.createElement('div')
    document.body.appendChild(containerEl)
    // default to dark app theme
    setupStore({ markdownPreviewLightBackground: false, theme: 'dark' })
  })

  afterEach(() => {
    if (root) {
      root.unmount()
    }
    if (containerEl && containerEl.parentNode) {
      containerEl.parentNode.removeChild(containerEl)
    }
    vi.clearAllMocks()
  })

  it('renders with markdown-dark class by default (follows app dark theme)', async () => {
    await act(async () => {
      root = createRoot(containerEl)
      root.render(
        React.createElement(MarkdownPreview, {
          content: '# hi',
          filePath: '/tmp/test.md',
          scrollCacheKey: 'test-dark'
        })
      )
    })
    // allow effects
    await act(async () => {})
    const preview = containerEl.querySelector('.markdown-preview')
    expect(preview?.className).toContain('markdown-dark')
    expect(preview?.className).not.toContain('markdown-light') // when not forced
  })

  it('renders with markdown-light class when markdownPreviewLightBackground is true (even on dark app theme)', async () => {
    setupStore({ markdownPreviewLightBackground: true, theme: 'dark' })
    await act(async () => {
      root = createRoot(containerEl)
      root.render(
        React.createElement(MarkdownPreview, {
          content: '# hi light',
          filePath: '/tmp/test.md',
          scrollCacheKey: 'test-light'
        })
      )
    })
    await act(async () => {})
    const preview = containerEl.querySelector('.markdown-preview')
    expect(preview?.className).toContain('markdown-light')
    // does not have dark
    expect(preview?.className).not.toContain('markdown-dark')
    // TOC shell receives light class too for visual continuity (see UI review)
    const shell = containerEl.querySelector('.markdown-preview-shell')
    expect(shell?.className).toContain('markdown-light')
  })

  it('uses markdown-light when app is light and flag is unset (follows theme)', async () => {
    setupStore({ markdownPreviewLightBackground: false, theme: 'light' })
    await act(async () => {
      root = createRoot(containerEl)
      root.render(
        React.createElement(MarkdownPreview, {
          content: '# hi',
          filePath: '/tmp/test.md',
          scrollCacheKey: 'test-light-app'
        })
      )
    })
    await act(async () => {})
    const preview = containerEl.querySelector('.markdown-preview')
    expect(preview?.className).toContain('markdown-light')
  })
})
