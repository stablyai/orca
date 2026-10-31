import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '@/store/types'
import {
  importNewExternalWorktreeInboxPaths,
  type NewExternalWorktreesInboxActionState
} from './new-external-worktrees-inbox-actions'
import type { resolveWorktreeVisibilityTargets } from './worktree-visibility-host-target'
import { getLatestRepoForVisibilityScope } from './worktree-visibility-repo-sources'
import {
  getActiveVisibilityMutation,
  startVisibilityMutation,
  finishVisibilityMutation,
  useVisibilityMutationFence,
  type ActiveVisibilityMutation
} from './worktree-visibility-mutation-fence'

export function useWorktreeVisibilityRecovery({
  isOpen,
  scanTargets,
  fetchWorktrees,
  updateRepo
}: {
  isOpen: boolean
  scanTargets: ReturnType<typeof resolveWorktreeVisibilityTargets>['scanTargets']
  fetchWorktrees: AppState['fetchWorktrees']
  updateRepo: AppState['updateRepo']
}) {
  type TargetState = {
    actionState: NewExternalWorktreesInboxActionState | null
    busyPath: string | null
    isToggling: boolean
    listState: 'checking' | 'ready' | 'failed'
  }
  const targetStatesRef = useRef(new Map<string, TargetState>())
  const targetStates = targetStatesRef.current
  const [, publishTargetStates] = useState(0)
  const scanKey = JSON.stringify(isOpen ? scanTargets : [])
  const scopes = JSON.stringify(isOpen ? scanTargets.flatMap((target) => target.scopes) : [])
  const currentMutationScopeRef = useRef(new Map<string, readonly string[]>())
  useLayoutEffect(() => {
    currentMutationScopeRef.current = new Map(
      isOpen
        ? scanTargets.flatMap((target) =>
            target.scopes.map((scope) => [scope, target.scopes] as const)
          )
        : []
    )
    for (const scope of targetStatesRef.current.keys()) {
      if (!currentMutationScopeRef.current.has(scope)) {
        targetStatesRef.current.delete(scope)
      }
    }
    return () => {
      currentMutationScopeRef.current = new Map()
    }
  }, [isOpen, scanTargets])
  const setTargetState = useCallback((scope: string, patch: Partial<TargetState>) => {
    const peers = currentMutationScopeRef.current.get(scope)
    if (!peers) {
      return
    }
    const { actionState, ...physicalState } = patch
    for (const peer of Object.keys(physicalState).length > 0 ? peers : [scope]) {
      targetStatesRef.current.set(peer, {
        actionState: null,
        busyPath: null,
        isToggling: false,
        listState: 'checking',
        ...targetStatesRef.current.get(peer),
        ...physicalState,
        ...(peer === scope && actionState !== undefined ? { actionState } : {})
      })
    }
    publishTargetStates((revision) => revision + 1)
  }, [])
  const refreshScope = useCallback(
    async (scope: string) => {
      const current = getLatestRepoForVisibilityScope(scope)
      return current
        ? fetchWorktrees(current.id, {
            requireAuthoritative: true,
            executionHostId: getRepoExecutionHostId(current)
          })
        : false
    },
    [fetchWorktrees]
  )
  const resetScope = useCallback(
    (scope: string, active: ActiveVisibilityMutation | undefined) => {
      const peers = currentMutationScopeRef.current.get(scope)
      if (scope !== peers?.[0] && !active) {
        setTargetState(scope, { actionState: null })
        return
      }
      const physicalActive = active ?? peers?.map(getActiveVisibilityMutation).find(Boolean)
      setTargetState(scope, {
        actionState: null,
        busyPath: physicalActive?.kind === 'row' ? physicalActive.path : null,
        isToggling: physicalActive?.kind === 'toggle'
      })
    },
    [setTargetState]
  )
  const settleScope = useCallback(
    (scope: string, ready: boolean) => {
      setTargetState(scope, {
        listState: ready ? 'ready' : 'failed',
        busyPath: null,
        isToggling: false
      })
    },
    [setTargetState]
  )
  useVisibilityMutationFence({
    scopes,
    refresh: refreshScope,
    reset: resetScope,
    settled: settleScope
  })
  useEffect(() => {
    if (!isOpen || scanKey === '[]') {
      return
    }
    let cancelled = false
    for (const [scope, peers] of currentMutationScopeRef.current) {
      if (scope !== peers[0]) {
        continue
      }
      // An existing write owns its confirmation refresh, including after modal reentry.
      if (peers.some(getActiveVisibilityMutation)) {
        continue
      }
      setTargetState(scope, { listState: 'checking' })
      void refreshScope(scope).then((ready) => {
        if (!cancelled && !peers.some(getActiveVisibilityMutation)) {
          settleScope(scope, ready)
        }
      })
    }
    return () => {
      cancelled = true
    }
  }, [isOpen, scanKey, refreshScope, setTargetState, settleScope])
  const handleRetryList = useCallback(async () => {
    for (const [scope, peers] of currentMutationScopeRef.current) {
      if (
        scope !== peers[0] ||
        !currentMutationScopeRef.current.has(scope) ||
        targetStates.get(scope)?.listState !== 'failed' ||
        peers.some(getActiveVisibilityMutation)
      ) {
        continue
      }
      setTargetState(scope, { listState: 'checking' })
      const checkingState = targetStatesRef.current.get(scope)
      const ready = await refreshScope(scope)
      if (
        targetStatesRef.current.get(scope) === checkingState &&
        !peers.some(getActiveVisibilityMutation)
      ) {
        settleScope(scope, ready)
      }
    }
  }, [targetStates, setTargetState, refreshScope, settleScope])
  const handleShowWorktree = useCallback(
    async (selectedRepo: Repo, worktreePath: string) => {
      const scope = getRepoHostIdentity(selectedRepo)
      const current = getLatestRepoForVisibilityScope(scope)
      if (
        !current ||
        !currentMutationScopeRef.current.has(scope) ||
        currentMutationScopeRef.current.get(scope)?.some(getActiveVisibilityMutation)
      ) {
        return
      }
      const mutation: ActiveVisibilityMutation = { kind: 'row', path: worktreePath }
      startVisibilityMutation(scope, mutation)
      setTargetState(scope, { busyPath: worktreePath })
      try {
        await importNewExternalWorktreeInboxPaths({
          projectId: current.id,
          repo: current,
          worktreePaths: [worktreePath],
          updateRepo: (id, updates) =>
            updateRepo(id, updates, { hostId: getRepoExecutionHostId(current) }),
          fetchWorktrees: (id, options) =>
            fetchWorktrees(id, { ...options, executionHostId: getRepoExecutionHostId(current) }),
          setInboxState: (_id, actionState) => {
            if (getActiveVisibilityMutation(scope) === mutation) {
              setTargetState(scope, {
                actionState,
                ...(actionState === null ? { listState: 'ready' } : {})
              })
            }
          }
        })
      } finally {
        if (getActiveVisibilityMutation(scope) === mutation) {
          finishVisibilityMutation(scope, mutation)
          setTargetState(scope, { busyPath: null })
        }
      }
    },
    [setTargetState, updateRepo, fetchWorktrees]
  )

  return {
    targetStates,
    currentMutationScopeRef,
    setTargetState,
    handleRetryList,
    handleShowWorktree
  }
}
