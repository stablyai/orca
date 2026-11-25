import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { GitBlameCommit } from '../../../../../shared/git/blame/git-blame-types'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'

export type LineBlame = { kind: 'commit'; commit: GitBlameCommit } | { kind: 'uncommitted' }

/**
 * Blame for the focused editor's cursor line, read by the status bar. `ownerId` is the publishing
 * editor, so split panes of one file stay distinct; `stale` keeps the last value (dimmed) while
 * typing or loading so the status bar doesn't shift; `released` means its editor is gone and the
 * next active editor may take it over; `git` is null when the commit can't open.
 */
export type FocusedLineBlame = {
  ownerId: string
  fileId: string
  line: LineBlame
  stale: boolean
  released: boolean
  git: RuntimeGitContext | null
}

const focusedLineBlameStore = createStore<FocusedLineBlame | null>(() => null)

function sameLineBlame(a: FocusedLineBlame | null, b: FocusedLineBlame | null): boolean {
  if (!a || !b) {
    return a === b
  }
  const commitA = a.line.kind === 'commit' ? a.line.commit : null
  const commitB = b.line.kind === 'commit' ? b.line.commit : null
  return (
    a.ownerId === b.ownerId &&
    a.fileId === b.fileId &&
    a.stale === b.stale &&
    a.released === b.released &&
    a.git === b.git &&
    a.line.kind === b.line.kind &&
    commitA === commitB
  )
}

export function getFocusedLineBlame(): FocusedLineBlame | null {
  return focusedLineBlameStore.getState()
}

export function publishFocusedLineBlame(next: FocusedLineBlame | null): void {
  if (!sameLineBlame(focusedLineBlameStore.getState(), next)) {
    focusedLineBlameStore.setState(next, true)
  }
}

/**
 * Keep the owner's blame (hidden) when its editor goes away, so the next active editor can take it
 * over as its loading placeholder instead of the status bar shifting.
 */
export function releaseFocusedLineBlame(ownerId: string): void {
  const current = focusedLineBlameStore.getState()
  if (current?.ownerId === ownerId && !current.released) {
    focusedLineBlameStore.setState({ ...current, stale: true, released: true }, true)
  }
}

export function useFocusedLineBlame(): FocusedLineBlame | null {
  return useStore(focusedLineBlameStore, (state) => state)
}
