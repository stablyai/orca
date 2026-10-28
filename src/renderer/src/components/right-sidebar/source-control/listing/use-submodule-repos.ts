import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GitSubmoduleRepo } from '../../../../../../shared/git-submodule-repo-types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

export type SubmoduleRepoAction = 'fetch' | 'pull' | 'push'

/** Only a git worktree on this machine: the main process resolves no submodule for other hosts. */
export function submoduleReposWorktreePath(input: {
  worktreePath: string
  isFolder: boolean
  activeRepoTarget: RuntimeClientTarget | null
  activeConnectionId: string | null
}): string | null {
  const { worktreePath, isFolder, activeRepoTarget, activeConnectionId } = input
  return !isFolder && activeRepoTarget?.kind === 'local' && !activeConnectionId
    ? worktreePath
    : null
}

export type UseSourceControlSubmoduleReposInput = {
  /** Null hides the section: folder workspaces and every host but this machine. */
  worktreePath: string | null
  onChanged: () => void
}

export type UseSourceControlSubmoduleReposResult = {
  repos: GitSubmoduleRepo[]
  busy: { path: string; action: SubmoduleRepoAction } | null
  runAction: (submodulePath: string, action: SubmoduleRepoAction) => Promise<void>
}

/** Read each initialized submodule once per worktree and after every action on one. */
export function useSourceControlSubmoduleRepos(
  input: UseSourceControlSubmoduleReposInput
): UseSourceControlSubmoduleReposResult {
  const { worktreePath, onChanged } = input
  const [loaded, setLoaded] = useState<{ worktreePath: string; repos: GitSubmoduleRepo[] } | null>(
    null
  )
  const [busy, setBusy] = useState<UseSourceControlSubmoduleReposResult['busy']>(null)
  const worktreePathRef = useRef(worktreePath)
  worktreePathRef.current = worktreePath

  const load = useCallback(async (path: string): Promise<void> => {
    try {
      const repos = await window.api.git.submoduleRepos({ worktreePath: path })
      // A late answer for a worktree the user left must not replace the current list.
      if (worktreePathRef.current === path) {
        setLoaded({ worktreePath: path, repos })
      }
    } catch {
      if (worktreePathRef.current === path) {
        setLoaded({ worktreePath: path, repos: [] })
      }
    }
  }, [])

  useEffect(() => {
    if (worktreePath) {
      void load(worktreePath)
    }
  }, [load, worktreePath])

  const runAction = useCallback(
    async (submodulePath: string, action: SubmoduleRepoAction): Promise<void> => {
      const path = worktreePathRef.current
      if (!path) {
        return
      }
      setBusy({ path: submodulePath, action })
      try {
        await window.api.git[action]({ worktreePath: path, submodulePath })
      } catch (error) {
        toast.error(extractIpcErrorMessage(error, `${action} failed`))
      } finally {
        setBusy(null)
        await load(path)
        onChanged()
      }
    },
    [load, onChanged]
  )

  return {
    repos: loaded && loaded.worktreePath === worktreePath ? loaded.repos : [],
    busy,
    runAction
  }
}
