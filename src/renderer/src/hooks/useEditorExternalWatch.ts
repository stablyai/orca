import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { FsChangeEvent, FsChangedPayload } from '../../../shared/filesystem-entry-types'
import {
  getEditorExternalWatchTargetKey,
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import { buildEditorExternalWatchEventHandler } from './editor-external-watch-event-reconciliation'
import { verifyLatchedEditorMoveDestinations } from './editor-external-watch-disk-verification'
import {
  captureEditorWatchDiskBaseline,
  collectEditorWatchCatchUpEvents,
  holdEditorAutosaveDuringCatchUp,
  type EditorWatchDiskBaseline
} from './editor-external-watch-catch-up'

function warnExternalWatchFailure(target: EditorExternalWatchTarget, err: unknown): void {
  console.warn('[filesystem-watch] failed to watch worktree', {
    worktreeId: target.worktreeId,
    worktreePath: target.worktreePath,
    connectionId: target.connectionId,
    error: err instanceof Error ? err.message : String(err)
  })
}

// Why: spans the watcher batch window plus delivery, so a change made before the baseline stat still arrives as a live event.
const UNWATCH_BASELINE_SETTLE_MS = 2_000

/** Keeps editor filesystem subscriptions alive beyond any individual editor surface. */
export function useEditorExternalWatch(): void {
  const { targets, targetsKey } = useAppStore(selectEditorExternalWatchTargets)
  // Subscribed targets, including ones still draining toward unwatch.
  const targetsRef = useRef<EditorExternalWatchTarget[]>([])
  const latestTargetsRef = useRef<EditorExternalWatchTarget[]>(targets)
  latestTargetsRef.current = targets
  const remoteWatchUnsubsRef = useRef(new Map<string, () => void>())
  // Draining target key -> drain token, so a superseded drain can't unwatch a re-drained target.
  const drainingRef = useRef(new Map<string, symbol>())
  const baselinesRef = useRef(new Map<string, EditorWatchDiskBaseline>())
  const fsChangedHandlerRef = useRef<
    ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  >(null)

  // Why: diff targets so unchanged worktrees keep their subscription; full teardown on every store change drops events in the gap.
  useEffect(() => {
    const nextTargets = latestTargetsRef.current
    const nextKeys = new Set(nextTargets.map(getEditorExternalWatchTargetKey))
    const subscribed = targetsRef.current
    const subscribedKeys = new Set(subscribed.map(getEditorExternalWatchTargetKey))
    const draining = drainingRef.current

    // Why: a dropped watch can't replay what it misses, so stamp its open files first and stay subscribed until that stamp settles.
    const drainTarget = async (target: EditorExternalWatchTarget, token: symbol): Promise<void> => {
      const key = getEditorExternalWatchTargetKey(target)
      const baseline = await captureEditorWatchDiskBaseline(target).catch(
        (): EditorWatchDiskBaseline => new Map()
      )
      await new Promise((resolve) => setTimeout(resolve, UNWATCH_BASELINE_SETTLE_MS))
      // Re-added or unmounted while draining: the watch never lapsed.
      if (draining.get(key) !== token) {
        return
      }
      draining.delete(key)
      baselinesRef.current.set(key, baseline)
      targetsRef.current = targetsRef.current.filter(
        (candidate) => getEditorExternalWatchTargetKey(candidate) !== key
      )
      unsubscribeTarget(target, remoteWatchUnsubsRef.current)
    }

    const catchUpTarget = async (
      target: EditorExternalWatchTarget,
      baseline: EditorWatchDiskBaseline,
      watchReady: Promise<unknown>
    ): Promise<void> => {
      const releaseAutosave = holdEditorAutosaveDuringCatchUp(target, baseline)
      try {
        await watchReady.catch(() => undefined)
        const events = await collectEditorWatchCatchUpEvents(target, baseline).catch(
          (): FsChangeEvent[] => []
        )
        const key = getEditorExternalWatchTargetKey(target)
        if (
          events.length > 0 &&
          targetsRef.current.some((candidate) => getEditorExternalWatchTargetKey(candidate) === key)
        ) {
          // Dirty matches are marked changed-on-disk synchronously here, before autosave resumes.
          fsChangedHandlerRef.current?.(
            { worktreePath: target.worktreePath, events },
            target.runtimeEnvironmentId
          )
        }
      } finally {
        releaseAutosave()
      }
    }

    for (const target of subscribed) {
      const key = getEditorExternalWatchTargetKey(target)
      if (!nextKeys.has(key) && !draining.has(key)) {
        const token = Symbol(key)
        draining.set(key, token)
        void drainTarget(target, token)
      }
    }
    for (const target of nextTargets) {
      const key = getEditorExternalWatchTargetKey(target)
      if (draining.delete(key) || subscribedKeys.has(key)) {
        continue
      }
      let watchReady: Promise<unknown> = Promise.resolve()
      if (target.runtimeEnvironmentId) {
        subscribeRuntimeTarget(target, remoteWatchUnsubsRef.current, fsChangedHandlerRef)
      } else {
        watchReady = window.api.fs
          .watchWorktree({
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          })
          .catch((err) => {
            // Why: SSH providers can disappear while tabs still reference the worktree; report the failure without an uncaught renderer promise.
            warnExternalWatchFailure(target, err)
          })
      }
      const baseline = baselinesRef.current.get(key)
      if (baseline) {
        baselinesRef.current.delete(key)
        void catchUpTarget(target, baseline, watchReady)
      }
    }
    targetsRef.current = [
      ...nextTargets,
      ...subscribed.filter((target) => draining.has(getEditorExternalWatchTargetKey(target)))
    ]
    // Why: final unmount cleanup owns teardown so target changes remain differential.
  }, [targetsKey])

  // Why: one stable fs:changed listener prevents target-key changes from opening an event-loss gap.
  useEffect(() => {
    const remoteWatchUnsubs = remoteWatchUnsubsRef.current
    const draining = drainingRef.current
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
      draining.clear()
      for (const target of targetsRef.current) {
        unsubscribeTarget(target, remoteWatchUnsubs)
      }
      targetsRef.current = []
      // Why: module-scoped reload timers survive StrictMode's synthetic cleanup; a late reload dispatch is harmless.
    }
  }, [])
}

function unsubscribeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>
): void {
  const key = getEditorExternalWatchTargetKey(target)
  const remoteUnsubscribe = remoteWatchUnsubs.get(key)
  if (remoteUnsubscribe) {
    remoteUnsubscribe()
    remoteWatchUnsubs.delete(key)
  } else {
    void window.api.fs.unwatchWorktree({
      worktreePath: target.worktreePath,
      connectionId: target.connectionId
    })
  }
}

function subscribeRuntimeTarget(
  target: EditorExternalWatchTarget,
  remoteWatchUnsubs: Map<string, () => void>,
  fsChangedHandlerRef: {
    current: ((payload: FsChangedPayload, runtimeEnvironmentId?: string | null) => void) | null
  }
): void {
  const runtimeEnvironmentId = target.runtimeEnvironmentId
  if (!runtimeEnvironmentId) {
    return
  }
  const key = getEditorExternalWatchTargetKey(target)
  remoteWatchUnsubs.set(
    key,
    subscribeEditorRuntimeFileWatch(
      { ...target, runtimeEnvironmentId },
      (payload) => fsChangedHandlerRef.current?.(payload, runtimeEnvironmentId),
      (error) => warnExternalWatchFailure(target, error)
    )
  )
}

export function verifyLatchedMoveDestinations(
  ...args: Parameters<typeof verifyLatchedEditorMoveDestinations>
): void {
  verifyLatchedEditorMoveDestinations(...args)
}
