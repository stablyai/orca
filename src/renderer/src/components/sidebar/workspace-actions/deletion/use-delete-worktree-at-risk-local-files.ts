import { useEffect, useEffectEvent, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeWorktreeAtRiskLocalFiles } from '@/runtime/source-control/git/runtime-git-status-client'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  hasWorktreeAtRiskLocalFiles,
  type WorktreeAtRiskLocalFiles
} from '../../../../../../shared/worktree/at-risk-local-files'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'
import { resolveDeleteTargetGitContext } from './use-delete-worktree-status-hydration'

/** Ignored files each delete target would lose, by host identity; hosts that can't tell stay absent. */
export function useDeleteWorktreeAtRiskLocalFiles({
  isOpen,
  deleteTargets,
  repoMap
}: {
  isOpen: boolean
  deleteTargets: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
}): ReadonlyMap<string, WorktreeAtRiskLocalFiles> {
  const repos = useAppStore((state) => state.repos)
  const generation = isOpen ? deleteTargets.map(getWorktreeHostIdentity).join('\n') : ''
  const [result, setResult] = useState<{
    generation: string
    files: Map<string, WorktreeAtRiskLocalFiles>
  }>({ generation: '', files: new Map() })
  const startScans = useEffectEvent((signal: AbortSignal) => {
    for (const target of deleteTargets) {
      if (target.isMainWorktree || isFolderWorkspaceDelete(repoMap, target)) {
        continue
      }
      const gitContext = resolveDeleteTargetGitContext(target, repos)
      if (!gitContext) {
        continue
      }
      const identity = getWorktreeHostIdentity(target)
      const publish = (files: WorktreeAtRiskLocalFiles): void =>
        setResult((current) => ({
          generation,
          files: new Map(current.generation === generation ? current.files : []).set(
            identity,
            files
          )
        }))
      void getRuntimeWorktreeAtRiskLocalFiles(gitContext, signal)
        .then((files) => {
          if (!signal.aborted && hasWorktreeAtRiskLocalFiles(files)) {
            publish(files)
          }
        })
        .catch((error: unknown) => {
          // Older hosts lack the method and keep today's dialog; any other failure is an unchecked result.
          const unsupported =
            error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
          if (!signal.aborted && !unsupported) {
            publish({ count: 0, samplePaths: [], complete: false })
          }
        })
    }
  })

  // Store updates re-render the dialog with new array identities; each scan walks files, so run once per target set.
  useEffect(() => {
    if (!isOpen) {
      return
    }
    const controller = new AbortController()
    startScans(controller.signal)
    return () => {
      controller.abort()
    }
  }, [generation, isOpen])

  return result.generation === generation ? result.files : EMPTY_FILES
}

const EMPTY_FILES = new Map<string, WorktreeAtRiskLocalFiles>()
