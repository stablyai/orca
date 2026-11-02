import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'

type EditorShotCleanup = {
  fileId: string
  /** The shot opened the tab, so closing it leaves the window as it found it. */
  openedByShot: boolean
  /** A copy shot's temporary folder workspace, removed with its tab. */
  scratchRepoId: string | null
  previousWorktreeId: string | null
}

let pending: EditorShotCleanup | null = null

/** Remembers what an editor shot changed, for `end-capture` to undo. */
export function planEditorShotCleanup(cleanup: EditorShotCleanup): void {
  pending = cleanup
}

/** Closes the tab the shot opened and removes a copy's workspace; the author's file is never
 *  written, since only a copy ever takes `--act` input unless the caller asked for in-place. */
export async function runEditorShotCleanup(): Promise<void> {
  const cleanup = pending
  pending = null
  if (!cleanup) {
    return
  }
  const state = useAppStore.getState()
  if (cleanup.openedByShot || cleanup.scratchRepoId) {
    // Why the store's close: a copy's acted buffer is thrown away with the copy, never prompted.
    state.closeFile(cleanup.fileId)
  }
  if (cleanup.scratchRepoId) {
    await state.removeProject(cleanup.scratchRepoId, {
      hostId: LOCAL_EXECUTION_HOST_ID,
      errorFeedback: 'silent',
      automaticCleanup: true
    })
  }
  const { previousWorktreeId } = cleanup
  const now = useAppStore.getState()
  if (
    previousWorktreeId &&
    now.activeWorktreeId !== previousWorktreeId &&
    now.getKnownWorktreeById(previousWorktreeId)
  ) {
    activateAndRevealWorktree(previousWorktreeId, { providesInitialSurface: true })
  }
}
