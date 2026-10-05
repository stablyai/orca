import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import { workspaceSessionStateSchema } from './workspace-session-schema'
import {
  applyEditorRecoverySessionDrafts,
  editorRecoverySessionResources
} from './editor-recovery-session'
import type { EditorRecoveryDraft } from './editor-recovery'
import type { PersistedOpenFile } from './workspace-session-state-types'

const file: PersistedOpenFile = {
  filePath: '/repo/note.txt',
  relativePath: 'note.txt',
  worktreeId: 'wt',
  language: 'plaintext',
  lastKnownDiskSignature: 'disk',
  recoveryId: 'buffer',
  recoveryRevision: 1
}
function draft(content = 'current'): EditorRecoveryDraft {
  return {
    ...file,
    hostId: 'runtime:one',
    runtimeEnvironmentId: 'one',
    bufferKind: 'edit',
    id: 'buffer',
    revision: 2,
    updatedAt: 123,
    state: 'active',
    byteLength: content.length,
    content
  }
}
function session(files: PersistedOpenFile[] = [file]) {
  return { ...getDefaultWorkspaceSession(), openFilesByWorktree: { wt: files } }
}

describe('recovery across session formats', () => {
  it('overlays the current draft with its baseline while leaving read-only files and layout intact', () => {
    const saved = session([
      { ...file, dirtyDraftContent: 'older' },
      { ...file, readOnly: true, filePath: '/repo/log' }
    ])
    const recovered = applyEditorRecoverySessionDrafts(saved, [draft('latest')])
    expect(recovered.openFilesByWorktree?.wt?.[0]).toMatchObject({
      dirtyDraftContent: 'latest',
      recoveryRevision: 2,
      lastKnownDiskSignature: 'disk'
    })
    expect(recovered.openFilesByWorktree?.wt?.[1]).toEqual(saved.openFilesByWorktree.wt[1])
    expect(recovered.tabsByWorktree).toBe(saved.tabsByWorktree)
    expect(editorRecoverySessionResources(saved, 'runtime:one')).toHaveLength(1)
    expect(editorRecoverySessionResources(saved, 'runtime:one')[0]?.hostId).toBe('runtime:one')
  })

  it('keeps newer compatibility snapshots after rollback or an interrupted journal write', () => {
    for (const savedFile of [
      {
        ...file,
        recoveryId: undefined,
        recoveryRevision: undefined,
        dirtyDraftContent: 'older-client edit'
      },
      { ...file, recoveryRevision: 2, dirtyDraftContent: 'checkpoint failed after this edit' },
      { ...file, recoveryRevision: 3, dirtyDraftContent: 'restored profile backup' }
    ]) {
      expect(
        applyEditorRecoverySessionDrafts(session([savedFile]), [draft()]).openFilesByWorktree
          ?.wt?.[0]
      ).toMatchObject({
        dirtyDraftContent: savedFile.dirtyDraftContent,
        filePath: savedFile.filePath
      })
      expect(
        applyEditorRecoverySessionDrafts(session([savedFile]), [draft()]).openFilesByWorktree
          ?.wt?.[0]?.recoveryId
      ).toBeUndefined()
    }
  })

  it('removes retired checkpoint text from an older snapshot without closing its tab', () => {
    const saved = session([{ ...file, dirtyDraftContent: 'already saved' }])
    const recovered = applyEditorRecoverySessionDrafts(saved, [null], new Set(['buffer']))
    expect(recovered.openFilesByWorktree?.wt?.[0]).toEqual({
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      lastKnownDiskSignature: file.lastKnownDiskSignature
    })
    expect(recovered.tabsByWorktree).toBe(saved.tabsByWorktree)
  })

  it('reads old sessions and preserves future optional buffer types without dropping their text', () => {
    const older = workspaceSessionStateSchema.parse(
      session([{ ...file, recoveryId: undefined, recoveryRevision: undefined }])
    )
    expect(older.openFilesByWorktree?.wt).toHaveLength(1)
    const future = workspaceSessionStateSchema.parse(
      session([
        { ...file, recoveryBufferKind: 'future-text-surface', dirtyDraftContent: 'future edit' }
      ])
    )
    expect(future.openFilesByWorktree?.wt?.[0]).toMatchObject({
      recoveryBufferKind: 'future-text-surface',
      dirtyDraftContent: 'future edit'
    })
  })
})
