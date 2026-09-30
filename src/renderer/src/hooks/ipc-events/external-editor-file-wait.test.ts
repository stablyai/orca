import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../store'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { tagExternalEditorFileWait } from './external-editor-file-wait'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true))

/** Open a local file through the production store so rekey/close behavior is exercised. */
function openPrompt(path = '/tmp/prompt.txt'): string {
  return useAppStore.getState().openFile(
    {
      filePath: path,
      relativePath: 'prompt.txt',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      runtimeEnvironmentId: null,
      language: 'plaintext',
      mode: 'edit'
    },
    { preview: false, suppressActiveRuntimeFallback: true }
  )
}

describe('external editor wait identities', () => {
  it('survives a production rekey and releases only the cancelled caller', () => {
    const fileId = openPrompt()
    const releaseFirst = tagExternalEditorFileWait(fileId, 'first')
    const releaseSecond = tagExternalEditorFileWait(fileId, 'second')
    expect(
      useAppStore.getState().rekeyOpenFilesForPathChange({
        rekeys: [
          {
            oldFileId: fileId,
            oldFilePath: '/tmp/prompt.txt',
            newFileId: '/tmp/moved/prompt.txt',
            newFilePath: '/tmp/moved/prompt.txt',
            newRelativePath: 'prompt.txt'
          }
        ]
      })
    ).toEqual({ ok: true })
    expect(useAppStore.getState().openFiles[0]?.externalEditorWaitIds).toEqual(['first', 'second'])
    const persisted = buildEditorSessionData(useAppStore.getState().openFiles, {}, {}, {}, {})
    expect(persisted.openFilesByWorktree?.[FLOATING_TERMINAL_WORKTREE_ID]?.[0]).not.toHaveProperty(
      'externalEditorWaitIds'
    )
    releaseFirst()
    expect(useAppStore.getState().openFiles[0]?.externalEditorWaitIds).toEqual(['second'])
    releaseSecond()
    expect(useAppStore.getState().openFiles[0]?.externalEditorWaitIds).toBeUndefined()
  })

  it('does not copy a caller identity into a new editor session', () => {
    const fileId = openPrompt()
    const release = tagExternalEditorFileWait(fileId, 'request')
    const original = useAppStore.getState().openFiles[0]
    if (!original) {
      throw new Error('Missing test editor')
    }
    const copiedId = useAppStore
      .getState()
      .openFile(
        { ...original, filePath: '/tmp/copy.txt', relativePath: 'copy.txt' },
        { suppressActiveRuntimeFallback: true }
      )
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === copiedId)?.externalEditorWaitIds
    ).toBeUndefined()
    expect(
      useAppStore.getState().openFiles.find((file) => file.id === fileId)?.externalEditorWaitIds
    ).toEqual(['request'])
    release()
  })

  it('strips every caller identity from close-all history and reopened tabs', () => {
    const firstId = openPrompt()
    const secondId = openPrompt('/tmp/second.txt')
    const releaseFirst = tagExternalEditorFileWait(firstId, 'first-caller')
    const releaseSecond = tagExternalEditorFileWait(secondId, 'second-caller')
    useAppStore.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    useAppStore.getState().closeAllFiles()
    const snapshots =
      useAppStore.getState().recentlyClosedEditorTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    expect(snapshots).toHaveLength(2)
    for (const snapshot of snapshots ?? []) {
      expect(snapshot).not.toHaveProperty('externalEditorWaitIds')
    }
    expect(useAppStore.getState().reopenClosedEditorTab(FLOATING_TERMINAL_WORKTREE_ID)).toBe(true)
    expect(useAppStore.getState().openFiles[0]?.externalEditorWaitIds).toBeUndefined()
    releaseFirst()
    releaseSecond()
  })

  it('never restores wait identities through recently closed tabs or reopening the same path', () => {
    const fileId = openPrompt()
    const release = tagExternalEditorFileWait(fileId, 'request')
    useAppStore.getState().closeFile(fileId)
    const snapshot =
      useAppStore.getState().recentlyClosedEditorTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(snapshot).toBeDefined()
    expect(snapshot).not.toHaveProperty('externalEditorWaitIds')
    openPrompt()
    release()
    expect(useAppStore.getState().openFiles[0]?.externalEditorWaitIds).toBeUndefined()
  })
})
