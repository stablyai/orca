import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'

export type LineBlame = { kind: 'commit'; commit: GitBlameCommit } | { kind: 'uncommitted' }

/** Blame for the focused editor's cursor line, read by the status bar. */
/** `git` is null when the commit cannot be opened from this editor. */
export type FocusedLineBlame = { fileId: string; line: LineBlame; git: RuntimeGitContext | null }

const focusedLineBlameStore = createStore<FocusedLineBlame | null>(() => null)

function sameLineBlame(a: FocusedLineBlame | null, b: FocusedLineBlame | null): boolean {
  if (!a || !b) {
    return a === b
  }
  const commitA = a.line.kind === 'commit' ? a.line.commit : null
  const commitB = b.line.kind === 'commit' ? b.line.commit : null
  return (
    a.fileId === b.fileId && a.git === b.git && a.line.kind === b.line.kind && commitA === commitB
  )
}

export function publishFocusedLineBlame(next: FocusedLineBlame | null): void {
  if (!sameLineBlame(focusedLineBlameStore.getState(), next)) {
    focusedLineBlameStore.setState(next, true)
  }
}

/** Clear only if `fileId` still owns the published blame, so a newly focused editor keeps it. */
export function clearFocusedLineBlame(fileId: string): void {
  if (focusedLineBlameStore.getState()?.fileId === fileId) {
    focusedLineBlameStore.setState(null, true)
  }
}

export function useFocusedLineBlame(): FocusedLineBlame | null {
  return useStore(focusedLineBlameStore, (state) => state)
}
