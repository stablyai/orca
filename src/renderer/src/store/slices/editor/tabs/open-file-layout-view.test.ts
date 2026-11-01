import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import { layoutEditorViewOfOpenFile, openFileOfLayoutEditorView } from './open-file-layout-view'

const WT = 'repo-1::/repo'

const CONFLICT = {
  kind: 'conflict-editable',
  conflictKind: 'both_modified',
  conflictStatus: 'unresolved',
  conflictStatusSource: 'git'
} as const

/** One open file per mode, holding every field its view carries. */
const FILES: [string, OpenFile][] = [
  [
    'an edit tab on a conflicted file',
    {
      id: '/repo/a.ts',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      conflict: CONFLICT,
      mode: 'edit'
    }
  ],
  [
    'a diff tab',
    {
      id: `${WT}::diff::branch::a.ts`,
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      worktreeId: WT,
      language: 'typescript',
      isDirty: false,
      runtimeEnvironmentId: 'env-1',
      externalSshTargetId: 'ssh-1',
      diffSource: 'branch',
      branchCompare: {
        baseRef: 'main',
        baseOid: 'b0',
        compareRef: 'feature',
        headOid: 'h0',
        mergeBase: 'm0',
        compareVersion: 'v1'
      },
      branchOldPath: 'old/a.ts',
      combinedAreaFilter: 'staged',
      skippedConflicts: [{ path: 'c.ts', conflictKind: 'both_added' }],
      isPreview: true,
      mode: 'diff'
    }
  ],
  [
    'a markdown preview tab',
    {
      id: 'preview:/repo/README.md',
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      readOnly: true,
      markdownPreviewSourceFileId: '/repo/README.md',
      markdownPreviewAnchor: 'setup',
      mode: 'markdown-preview'
    }
  ],
  [
    'a conflict review tab',
    {
      id: `${WT}::conflict-review`,
      filePath: '/repo',
      relativePath: 'Conflict Review',
      worktreeId: WT,
      language: 'plaintext',
      isDirty: false,
      conflictReview: {
        source: 'live-summary',
        snapshotTimestamp: 1_700_000_000_000,
        entries: [{ path: 'a.ts', conflictKind: 'both_modified' }]
      },
      mode: 'conflict-review'
    }
  ],
  [
    'a check details tab',
    {
      id: 'check:build',
      filePath: 'check:build',
      relativePath: 'build',
      worktreeId: WT,
      language: 'plaintext',
      isDirty: false,
      checkRunDetails: {
        contextKey: 'pr-1',
        check: { name: 'build', status: 'completed', conclusion: 'success', url: null },
        details: null,
        loading: false,
        error: null
      },
      mode: 'check-details'
    }
  ]
]

describe("an editor tab's open file and main's view of it", () => {
  it.each(FILES)('%s round-trips through its view', (_name, file) => {
    const view = layoutEditorViewOfOpenFile(file)

    expect(view?.view.mode).toBe(file.mode)
    expect(
      openFileOfLayoutEditorView(view!, {
        entityId: file.id,
        worktreeId: file.worktreeId,
        isPreview: file.isPreview
      })
    ).toEqual(file)
  })

  it('has no view for a plain edit-mode file', () => {
    const [, conflicted] = FILES[0]!
    expect(layoutEditorViewOfOpenFile({ ...conflicted, conflict: undefined })).toBeNull()
  })

  it('leaves out what only this window knows about the file', () => {
    const [, diff] = FILES[1]!
    const view = layoutEditorViewOfOpenFile({
      ...diff,
      isDirty: true,
      terminalArtifactGrantId: 'grant-1',
      diffContentReloadNonce: 3,
      externalMutation: 'changed',
      mirroredFromRuntimeSession: true
    })

    const rebuilt = openFileOfLayoutEditorView(view!, { entityId: diff.id, worktreeId: WT })
    expect(rebuilt).toEqual({ ...diff, isPreview: undefined })
    expect(Object.keys(rebuilt)).not.toContain('isPreview')
  })
})
