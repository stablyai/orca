import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeWorktreeAtRiskLocalFiles } from '@/runtime/source-control/git/runtime-git-status-client'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'
import { resolveDeleteTargetGitContext } from './use-delete-worktree-status-hydration'

export type DeleteWorktreeLocalFilesState =
  | { status: 'checking' }
  | { status: 'unsupported' }
  | { status: 'complete'; files: WorktreeAtRiskLocalFiles }

const CHECKING_STATE: DeleteWorktreeLocalFilesState = { status: 'checking' }
const UNSUPPORTED_STATE: DeleteWorktreeLocalFilesState = { status: 'unsupported' }
const EMPTY_STATES = new Map<string, DeleteWorktreeLocalFilesState>()

/** Per-target ignored-file check state, including targets whose scans have yet to start. */
export function useDeleteWorktreeAtRiskLocalFiles({
  isOpen,
  deleteTargets,
  repoMap
}: {
  isOpen: boolean
  deleteTargets: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
}): ReadonlyMap<string, DeleteWorktreeLocalFilesState> {
  const repos = useAppStore((state) => state.repos)
  const generation = isOpen
    ? deleteTargets
        .map((target) =>
          JSON.stringify({
            identity: getWorktreeHostIdentity(target),
            isMainWorktree: target.isMainWorktree,
            isFolderWorkspace: isFolderWorkspaceDelete(repoMap, target),
            context: resolveDeleteTargetGitContext(target, repos)
          })
        )
        .sort()
        .join('\n')
    : ''
  const [settled, setSettled] = useState<{
    generation: string
    states: Map<string, DeleteWorktreeLocalFilesState>
  }>({ generation: '', states: new Map() })

  const startScans = useEffectEvent((signal: AbortSignal) => {
    for (const target of deleteTargets) {
      if (target.isMainWorktree || isFolderWorkspaceDelete(repoMap, target)) {
        continue
      }
      const identity = getWorktreeHostIdentity(target)
      const publish = (state: DeleteWorktreeLocalFilesState): void =>
        setSettled((current) => ({
          generation,
          states: new Map(current.generation === generation ? current.states : []).set(
            identity,
            state
          )
        }))
      const gitContext = resolveDeleteTargetGitContext(target, repos)
      if (!gitContext) {
        publish(UNSUPPORTED_STATE)
        continue
      }
      void getRuntimeWorktreeAtRiskLocalFiles(gitContext, signal)
        .then((files) => {
          if (!signal.aborted) {
            publish({ status: 'complete', files })
          }
        })
        .catch((error: unknown) => {
          if (signal.aborted) {
            return
          }
          const unsupported =
            error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
          publish(
            unsupported
              ? UNSUPPORTED_STATE
              : {
                  status: 'complete',
                  files: { count: 0, samplePaths: [], paths: [], complete: false }
                }
          )
        })
    }
  })

  // Store updates re-render the dialog with new array identities; each scan walks files, so run once per target set.
  useEffect(() => {
    setSettled({ generation, states: new Map() })
    if (!isOpen) {
      return
    }
    const controller = new AbortController()
    startScans(controller.signal)
    return () => {
      controller.abort()
    }
  }, [generation, isOpen])

  return useMemo(() => {
    if (!isOpen) {
      return EMPTY_STATES
    }
    const currentSettled = settled.generation === generation ? settled.states : undefined
    const next = new Map<string, DeleteWorktreeLocalFilesState>()
    for (const target of deleteTargets) {
      if (target.isMainWorktree || isFolderWorkspaceDelete(repoMap, target)) {
        continue
      }
      const identity = getWorktreeHostIdentity(target)
      next.set(identity, currentSettled?.get(identity) ?? CHECKING_STATE)
    }
    return next
  }, [deleteTargets, generation, isOpen, repoMap, settled])
}
