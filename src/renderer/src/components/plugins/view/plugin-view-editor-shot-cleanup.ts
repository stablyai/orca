import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useAppStore } from '@/store'

type EditorShotCleanup = {
  fileId: string
  /** The shot opened the tab and nothing was meant to stay, so closing it leaves the window as it
   *  found it. False for `--act --in-place`, whose unsaved edits live in the tab. */
  openedByShot: boolean
  /** A copy shot's temporary folder workspace, removed with its tab. */
  scratchRepoId: string | null
  previousWorktreeId: string | null
}

// Per capture: overlapping shots each undo only their own changes.
const pending = new Map<string, EditorShotCleanup>()

/** Remembers what editor capture `captureId` changed, for its `end-capture` to undo. */
export function planEditorShotCleanup(captureId: string, cleanup: EditorShotCleanup): void {
  pending.set(captureId, cleanup)
}

/** Closes the tab the shot opened and removes a copy's workspace; the author's file is never
 *  written, since only a copy ever takes `--act` input unless the caller asked for in-place. */
export async function runEditorShotCleanup(captureId: string | undefined): Promise<void> {
  const cleanup = captureId === undefined ? undefined : pending.get(captureId)
  if (captureId !== undefined) {
    pending.delete(captureId)
  }
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
