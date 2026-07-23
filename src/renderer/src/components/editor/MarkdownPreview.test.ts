import { describe, expect, it } from 'vitest'
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
import { extractText } from './CodeBlockCopyButton'

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

describe('extractText for markdown code blocks', () => {
  it('preserves multiline mermaid content without array comma insertion', () => {
    const lines = [
      'flowchart LR\n',
      '    PATH3D["3D Ground‑Truth Trajectory Point P(x, y, z)"] --> PROJ["Camera Intrinsics/Extrinsics 3D → 2D Projection"]\n',
      '    PROJ --> PIXEL["2D Image Pixel Coordinates (u, v)"]\n',
      '    DEPTH["Camera Depth Map"] --> FILTER{"Depth Occlusion Filter:<br/>Distance > Depth ?"}\n',
      '    PIXEL --> FILTER\n',
      '    FILTER -- "Yes (Occluded)" --> DISCARD["Discard Invisible Point"]\n',
      '    FILTER -- "No (Visible)" --> FAR{"Calculate Visible-Point Distance:<br/>Select Farthest Pixel Goal"}\n',
      '    FAR --> TARGET["Generate Training Token: <pixel_u, pixel_v>"]'
    ]
    const extracted = extractText(lines)
    expect(extracted).toBe(lines.join(''))
  })
})
