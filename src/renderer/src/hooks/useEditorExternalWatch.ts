import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-client'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTarget,
  type EditorExternalWatchTargetState as EditorExternalWatchTargetStateShape
} from './editor-external-watch-targets'
import {
  buildEditorExternalWatchEventHandler,
  collectOverflowEditorExternalReloadTargets
} from './editor-external-watch-event-reconciliation'
import { verifyLatchedEditorMoveDestinations } from './editor-external-watch-disk-verification'

export type EditorExternalWatchTargetState = EditorExternalWatchTargetStateShape

function warnExternalWatchFailure(target: EditorExternalWatchTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

/** Keeps editor filesystem subscriptions alive beyond any individual editor surface. */
export function useEditorExternalWatch(): void {
  const { targets, targetsKey } = useAppStore(selectEditorExternalWatchTargets)
  const targetsRef = useRef<EditorExternalWatchTarget[]>([])
  const latestTargetsRef = useRef<EditorExternalWatchTarget[]>(targets)
  latestTargetsRef.current = targets
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  const fsChangedHandlerRef = useRef<
    ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  >(null)

  // Why: diff targets so unchanged worktrees keep their subscription; full teardown on every store change drops events in the gap.
  useEffect(() => {
    const nextTargets = latestTargetsRef.current
    const previousTargets = targetsRef.current
    const previousKeys = new Set(previousTargets.map(getEditorExternalWatchTargetKey))
    const nextKeys = new Set(nextTargets.map(getEditorExternalWatchTargetKey))
    const removed = previousTargets.filter(
      (target) => !nextKeys.has(getEditorExternalWatchTargetKey(target))
    )
    const added = nextTargets.filter(
      (target) => !previousKeys.has(getEditorExternalWatchTargetKey(target))
    )

    for (const target of removed) {
      const key = getEditorExternalWatchTargetKey(target)
      const remoteUnsubscribe = remoteWatchUnsubsRef.current.get(key)
      if (remoteUnsubscribe) {
        remoteUnsubscribe()
        remoteWatchUnsubsRef.current.delete(key)
      } else {
        void window.api.fs.unwatchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
      }
    }
    for (const target of added) {
      if (target.runtimeEnvironmentId) {
        subscribeRuntimeTarget(target, remoteWatchUnsubsRef.current, fsChangedHandlerRef)
        continue
      }
      void window.api.fs
        .watchWorktree({
          worktreePath: target.worktreePath,
          connectionId: target.connectionId
        })
        .catch((err) => {
          // Why: SSH providers can disappear while tabs still reference the worktree; report the failure without an uncaught renderer promise.
          warnExternalWatchFailure(target, err)
        })
    }
    targetsRef.current = nextTargets
    // Why: final unmount cleanup owns teardown so target changes remain differential.
  }, [targetsKey])

  // Why: one stable fs:changed listener prevents target-key changes from opening an event-loss gap.
  useEffect(() => {
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const { handleFsChanged, dispose } = buildEditorExternalWatchEventHandler(
      (worktreePath, runtimeEnvironmentId) =>
        targetsRef.current.find(
          (target) =>
            normalizeRuntimePathForComparison(target.worktreePath) ===
              normalizeRuntimePathForComparison(worktreePath) &&
            target.runtimeEnvironmentId === runtimeEnvironmentId
        )
    )
    const unsubscribe = window.api.fs.onFsChanged((payload) => handleFsChanged(payload, null))
    fsChangedHandlerRef.current = handleFsChanged

    return () => {
      unsubscribe()
      dispose()
      fsChangedHandlerRef.current = null
      for (const target of targetsRef.current) {
        const key = getEditorExternalWatchTargetKey(target)
        const remoteUnsubscribe = remoteWatchUnsubs.get(key)
        if (remoteUnsubscribe) {
          remoteUnsubscribe()
        } else {
          void window.api.fs.unwatchWorktree({
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          })
        }
      }
      remoteWatchUnsubs.clear()
      targetsRef.current = []
      // Why: module-scoped reload timers survive StrictMode's synthetic cleanup; a late reload dispatch is harmless.
    }
  }, [])
}

function subscribeRuntimeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>,
  fsChangedHandlerRef: {
    current: ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  }
): void {
  const key = getEditorExternalWatchTargetKey(target)
  let cancelled = false
  const pendingUnsubscribe = (): void => {
    cancelled = true
  }
  remoteWatchUnsubs.set(key, pendingUnsubscribe)
  void subscribeRuntimeFileChanges(
    {
      settings: { activeRuntimeEnvironmentId: target.runtimeEnvironmentId! },
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      connectionId: target.connectionId
    },
    (payload) => fsChangedHandlerRef.current?.(payload, target.runtimeEnvironmentId),
    (err) => warnExternalWatchFailure(target, err)
  )
    .then((unsubscribe) => {
      if (cancelled) {
        unsubscribe()
        return
      }
      if (remoteWatchUnsubs.get(key) === pendingUnsubscribe) {
        remoteWatchUnsubs.set(key, unsubscribe)
      } else {
        unsubscribe()
      }
    })
    .catch((err) => {
      if (remoteWatchUnsubs.get(key) === pendingUnsubscribe) {
        remoteWatchUnsubs.delete(key)
      }
      warnExternalWatchFailure(target, err)
    })
}

// Compatibility delegates keep existing direct imports stable without turning this module into an export barrel.
export function getWatchedTargetKey(target: EditorExternalWatchTarget): string {
  return getEditorExternalWatchTargetKey(target)
}

export function getEditorExternalWatchTargets(
  state: EditorExternalWatchTargetState
): ReturnType<typeof selectEditorExternalWatchTargets> {
  return selectEditorExternalWatchTargets(state)
}

export function createExternalWatchEventHandler(
  ...args: Parameters<typeof buildEditorExternalWatchEventHandler>
): ReturnType<typeof buildEditorExternalWatchEventHandler> {
  return buildEditorExternalWatchEventHandler(...args)
}

export function verifyLatchedMoveDestinations(
  ...args: Parameters<typeof verifyLatchedEditorMoveDestinations>
): void {
  verifyLatchedEditorMoveDestinations(...args)
}

export function getOverflowExternalReloadTargets(
  ...args: Parameters<typeof collectOverflowEditorExternalReloadTargets>
): ReturnType<typeof collectOverflowEditorExternalReloadTargets> {
  return collectOverflowEditorExternalReloadTargets(...args)
}
