import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { areGitStatusEntriesEqual } from '../../../../../../shared/git/status/git-status-entries-equal'
import { isWslDistroNotRunningRefusal } from '../../../../../../shared/wsl-distro-not-running-refusal'
import { resolveWorktreeGitCopyNow, useWorktreeGitCopyHostId } from '@/lib/worktree-git-copy'
import { getRuntimeGitSubmoduleStatus } from '@/runtime/runtime-git-status-client'
import {
  getGitStatusRefreshScopeKey,
  subscribeToSuccessfulGitStatusRefresh
} from '../sync/git-status-successful-refresh'
import {
  getSubmoduleExpansionKey,
  isExpandableSubmoduleEntry,
  parseSubmoduleExpansionKey,
  type SubmoduleStatusState
} from './submodule-expansion'

export type UseSourceControlSubmoduleStatusInput = {
  activeWorktreeId: string | null | undefined
  worktreePath: string | null
  activeRepoTarget: RuntimeClientTarget | null
  entries: readonly GitStatusEntry[]
}

export type UseSourceControlSubmoduleStatusResult = {
  expandedSubmoduleKeys: Set<string>
  submoduleStatusByKey: Record<string, SubmoduleStatusState>
  toggleSubmodule: (entry: Pick<GitStatusEntry, 'area' | 'path'>) => void
  retrySubmodule: (expansionKey: string) => void
}

type SubmoduleRequests = {
  epoch: object
  update: (entries: readonly GitStatusEntry[], expanded: Set<string>) => void
  refresh: (expansionKey: string) => void
}

/** Load inner status only for expanded submodules so parent polling never recurses. */
export function useSourceControlSubmoduleStatus(
  input: UseSourceControlSubmoduleStatusInput
): UseSourceControlSubmoduleStatusResult {
  const { activeWorktreeId, worktreePath, activeRepoTarget, entries } = input
  const selectedHostId = useWorktreeGitCopyHostId(activeWorktreeId ?? null)
  const copy =
    activeWorktreeId && activeRepoTarget
      ? resolveWorktreeGitCopyNow(activeWorktreeId, selectedHostId)
      : null
  const ownerHostId = copy?.hostId ?? null
  const connectionId = copy?.connectionId
  const runtimeEnvironmentId =
    copy?.transport.kind === 'environment' ? copy.transport.environmentId : null
  const scopeKey =
    copy && worktreePath
      ? getGitStatusRefreshScopeKey({
          target: copy.transport,
          ownerHostId,
          connectionId,
          worktreeId: copy.worktreeId,
          worktreePath
        })
      : null
  const [store, setStore] = useState<{
    scopeKey: string | null
    epoch: object
    expanded: Set<string>
    byKey: Record<string, SubmoduleStatusState>
  }>(() => ({
    scopeKey,
    epoch: {},
    expanded: new Set<string>(),
    byKey: {}
  }))
  if (store.scopeKey !== scopeKey) {
    setStore({ scopeKey, epoch: {}, expanded: new Set(), byKey: {} })
  }
  const { epoch, expanded: expandedSubmoduleKeys, byKey: submoduleStatusByKey } = store
  const requestsRef = useRef<SubmoduleRequests | null>(null)

  useEffect(() => {
    if (!scopeKey || !activeWorktreeId || !worktreePath) {
      return
    }
    const target: RuntimeClientTarget =
      runtimeEnvironmentId === null
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: runtimeEnvironmentId }
    let live = true
    let expandableKeys = new Set<string>()
    let expanded = new Set<string>()
    const active = new Map<string, { trailing: boolean }>()
    const updateExpandableKeys = (nextEntries: readonly GitStatusEntry[]): void => {
      expandableKeys = new Set(
        nextEntries.filter(isExpandableSubmoduleEntry).map(getSubmoduleExpansionKey)
      )
    }
    const visible = (key: string): boolean => expanded.has(key) && expandableKeys.has(key)
    const apply = (
      key: string,
      update: (prev?: SubmoduleStatusState) => SubmoduleStatusState | undefined
    ): void => {
      if (!live || !visible(key)) {
        return
      }
      setStore((prev) => {
        if (prev.epoch !== epoch) {
          return prev
        }
        const next = update(prev.byKey[key])
        return !next || next === prev.byKey[key]
          ? prev
          : { ...prev, byKey: { ...prev.byKey, [key]: next } }
      })
    }
    const fail = (key: string, error: unknown): void => {
      apply(key, (prev) => {
        if (prev?.status === 'loaded' && isWslDistroNotRunningRefusal(error)) {
          return prev.refreshing ? { ...prev, refreshing: false } : prev
        }
        const message = error instanceof Error ? error.message : String(error)
        return prev?.status === 'loaded'
          ? { ...prev, error: message, refreshing: false }
          : { status: 'error', error: message }
      })
    }
    const refresh = (key: string): void => {
      if (!live || !visible(key)) {
        return
      }
      const running = active.get(key)
      if (running) {
        running.trailing = true
        return
      }
      const parsed = parseSubmoduleExpansionKey(key)
      if (!parsed) {
        return
      }
      const request = { trailing: false }
      active.set(key, request)
      apply(key, (prev) => {
        if (!prev) {
          return { status: 'loading' }
        }
        return prev.status === 'error' || (prev.status === 'loaded' && prev.error !== undefined)
          ? { ...prev, refreshing: true }
          : prev
      })
      void (async () => {
        try {
          const result = await getRuntimeGitSubmoduleStatus(
            { target, worktreeId: activeWorktreeId, worktreePath, connectionId },
            parsed.path,
            parsed.area
          )
          if (result.readError !== undefined) {
            fail(key, result.readError)
          } else {
            apply(key, (prev) =>
              prev?.status === 'loaded' &&
              prev.error === undefined &&
              !prev.refreshing &&
              Boolean(prev.didHitLimit) === Boolean(result.didHitLimit) &&
              areGitStatusEntriesEqual(prev.entries, result.entries)
                ? prev
                : {
                    status: 'loaded',
                    entries: result.entries,
                    ...(result.didHitLimit ? { didHitLimit: true } : {})
                  }
            )
          }
        } catch (error) {
          fail(key, error)
        } finally {
          active.delete(key)
          if (request.trailing) {
            refresh(key)
          }
        }
      })()
    }
    const refreshExpanded = (): void => {
      for (const key of expanded) {
        refresh(key)
      }
    }
    const requests: SubmoduleRequests = {
      epoch,
      refresh,
      update(nextEntries, nextExpanded) {
        const previousExpanded = expanded
        updateExpandableKeys(nextEntries)
        expanded = nextExpanded
        for (const [key, request] of active) {
          if (!visible(key)) {
            request.trailing = false
          }
        }
        for (const key of expanded) {
          if (!previousExpanded.has(key)) {
            refresh(key)
          }
        }
      }
    }
    requestsRef.current = requests
    const unsubscribe = subscribeToSuccessfulGitStatusRefresh(scopeKey, (acceptedEntries) => {
      updateExpandableKeys(acceptedEntries)
      refreshExpanded()
    })
    return () => {
      live = false
      unsubscribe()
      if (requestsRef.current === requests) {
        requestsRef.current = null
      }
    }
  }, [scopeKey, epoch, activeWorktreeId, worktreePath, runtimeEnvironmentId, connectionId])

  useEffect(() => {
    if (requestsRef.current?.epoch === epoch) {
      requestsRef.current.update(entries, expandedSubmoduleKeys)
    }
  }, [entries, expandedSubmoduleKeys, epoch])

  const toggleSubmodule = useCallback(
    (entry: Pick<GitStatusEntry, 'area' | 'path'>) => {
      const key = getSubmoduleExpansionKey(entry)
      setStore((prev) => {
        if (prev.epoch !== epoch) {
          return prev
        }
        const expanded = new Set(prev.expanded)
        if (expanded.has(key)) {
          expanded.delete(key)
        } else {
          expanded.add(key)
        }
        return { ...prev, expanded }
      })
    },
    [epoch]
  )
  const retrySubmodule = useCallback(
    (key: string) => {
      if (requestsRef.current?.epoch === epoch) {
        requestsRef.current.refresh(key)
      }
    },
    [epoch]
  )

  return { expandedSubmoduleKeys, submoduleStatusByKey, toggleSubmodule, retrySubmodule }
}
