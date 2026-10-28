import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

export type SubmoduleChangesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: GitStatusEntry[] }

export type UseSourceControlSubmoduleChangesInput = {
  /** Null clears everything: the section is hidden for this worktree. */
  worktreePath: string | null
  /** A commit moves the submodule's branch, so the list and the parent status are stale. */
  onCommitted: () => void
}

export type UseSourceControlSubmoduleChangesResult = {
  expanded: ReadonlySet<string>
  changesByPath: Readonly<Record<string, SubmoduleChangesState>>
  messageByPath: Readonly<Record<string, string>>
  /** The submodule with an action in flight; other submodules stay usable. */
  busyPath: string | null
  toggle: (submodulePath: string) => void
  setMessage: (submodulePath: string, message: string) => void
  stage: (submodulePath: string, filePaths: readonly string[]) => Promise<void>
  unstage: (submodulePath: string, filePaths: readonly string[]) => Promise<void>
  commit: (submodulePath: string) => Promise<void>
}

function commitFailedMessage(): string {
  return translate(
    'auto.components.right.sidebar.SourceControl.submoduleCommitFailed',
    'Commit failed'
  )
}

type Scoped = {
  worktreePath: string | null
  expanded: Set<string>
  changesByPath: Record<string, SubmoduleChangesState>
  messageByPath: Record<string, string>
}

const EMPTY_SCOPE = (worktreePath: string | null): Scoped => ({
  worktreePath,
  expanded: new Set(),
  changesByPath: {},
  messageByPath: {}
})

/** Read a submodule's own changes while its row is open, and stage, unstage and commit them there. */
export function useSourceControlSubmoduleChanges(
  input: UseSourceControlSubmoduleChangesInput
): UseSourceControlSubmoduleChangesResult {
  const { worktreePath, onCommitted } = input
  const [scoped, setScoped] = useState<Scoped>(() => EMPTY_SCOPE(worktreePath))
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const worktreePathRef = useRef(worktreePath)
  worktreePathRef.current = worktreePath

  // Reset during render so a worktree switch cannot paint the previous worktree's open rows.
  const current = scoped.worktreePath === worktreePath ? scoped : EMPTY_SCOPE(worktreePath)
  if (current !== scoped) {
    setScoped(current)
  }

  const update = useCallback((path: string, change: (state: Scoped) => Scoped): void => {
    // A late answer for a worktree the user left must not touch the current one.
    setScoped((state) => (state.worktreePath === path ? change(state) : state))
  }, [])

  const load = useCallback(
    async (submodulePath: string): Promise<void> => {
      const path = worktreePathRef.current
      if (!path) {
        return
      }
      try {
        const result = await window.api.git.status({
          worktreePath: path,
          submodulePath,
          includeIgnored: false,
          includeLineStats: false,
          admissionTier: 'interactive'
        })
        update(path, (state) => ({
          ...state,
          changesByPath: {
            ...state.changesByPath,
            [submodulePath]: { status: 'ready', entries: result.entries }
          }
        }))
      } catch (error) {
        update(path, (state) => ({
          ...state,
          changesByPath: {
            ...state.changesByPath,
            [submodulePath]: {
              status: 'error',
              message: extractIpcErrorMessage(error, 'Could not read the submodule changes')
            }
          }
        }))
      }
    },
    [update]
  )

  const toggle = useCallback(
    (submodulePath: string): void => {
      const path = worktreePathRef.current
      if (!path) {
        return
      }
      const opening = !current.expanded.has(submodulePath)
      update(path, (state) => {
        const expanded = new Set(state.expanded)
        if (opening) {
          expanded.add(submodulePath)
        } else {
          expanded.delete(submodulePath)
        }
        return { ...state, expanded }
      })
      // Read when a row opens; later reads follow this hook's own actions.
      if (opening) {
        void load(submodulePath)
      }
    },
    [current.expanded, load, update]
  )

  const setMessage = useCallback(
    (submodulePath: string, message: string): void => {
      const path = worktreePathRef.current
      if (path) {
        update(path, (state) => ({
          ...state,
          messageByPath: { ...state.messageByPath, [submodulePath]: message }
        }))
      }
    },
    [update]
  )

  const runIndexAction = useCallback(
    async (
      submodulePath: string,
      action: 'bulkStage' | 'bulkUnstage',
      filePaths: readonly string[]
    ): Promise<void> => {
      const path = worktreePathRef.current
      if (!path || filePaths.length === 0) {
        return
      }
      setBusyPath(submodulePath)
      try {
        await window.api.git[action]({
          worktreePath: path,
          submodulePath,
          filePaths: [...filePaths]
        })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, `${action} failed`))
      } finally {
        setBusyPath(null)
        await load(submodulePath)
      }
    },
    [load]
  )

  const stage = useCallback(
    (submodulePath: string, filePaths: readonly string[]) =>
      runIndexAction(submodulePath, 'bulkStage', filePaths),
    [runIndexAction]
  )
  const unstage = useCallback(
    (submodulePath: string, filePaths: readonly string[]) =>
      runIndexAction(submodulePath, 'bulkUnstage', filePaths),
    [runIndexAction]
  )

  const commit = useCallback(
    async (submodulePath: string): Promise<void> => {
      const path = worktreePathRef.current
      const message = (scoped.messageByPath[submodulePath] ?? '').trim()
      if (!path || !message) {
        return
      }
      setBusyPath(submodulePath)
      let committed = false
      try {
        const result = await window.api.git.commit({ worktreePath: path, submodulePath, message })
        if (result.success) {
          committed = true
          update(path, (state) => ({
            ...state,
            messageByPath: { ...state.messageByPath, [submodulePath]: '' }
          }))
        } else {
          toast.error(result.error ?? commitFailedMessage())
        }
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, commitFailedMessage()))
      } finally {
        setBusyPath(null)
        await load(submodulePath)
        if (committed) {
          onCommitted()
        }
      }
    },
    [load, onCommitted, scoped.messageByPath, update]
  )

  return {
    expanded: current.expanded,
    changesByPath: current.changesByPath,
    messageByPath: current.messageByPath,
    busyPath,
    toggle,
    setMessage,
    stage,
    unstage,
    commit
  }
}
