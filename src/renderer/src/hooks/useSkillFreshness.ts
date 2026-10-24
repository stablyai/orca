import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../shared/bundled-skill-summary'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import {
  planBundledSkillsOnTarget,
  type BundledSkillPlanResult,
  type BundledSkillUnsupportedReason
} from '@/runtime/runtime-bundled-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'

// Why: window focus fires on every alt-tab, and each plan re-reads and re-hashes every
// target; a just-completed plan stays authoritative briefly.
const FOCUS_RESCAN_COOLDOWN_MS = 15_000
// Why one target: every surface derives it from the same store, so they all plan one host.
let activeTarget: BundledSkillTarget | null = null
let cachedPlan: { targetKey: string; result: BundledSkillPlanResult; revision: number } | null =
  null
let pendingPlan: {
  targetKey: string
  request: Promise<BundledSkillPlanResult>
} | null = null
let invalidationRevision = 0
let lastCompletedScanAt = 0
let refreshSequence = 0
let scheduledFocusRescan: number | null = null

type SkillFreshnessSnapshot = {
  /** The host this snapshot describes; a surface on another target never reads it. */
  targetKey: string | null
  plan: BundledSkillPlan | null
  /** Why this host can't be planned: an older server, or an SSH host no server serves yet. */
  unsupported: BundledSkillUnsupportedReason | null
  loading: boolean
  error: string | null
}

const IDLE = { plan: null, unsupported: null, loading: false, error: null } as const
let snapshot: SkillFreshnessSnapshot = { ...IDLE, targetKey: null }
const DISABLED_SNAPSHOT: SkillFreshnessSnapshot = Object.freeze({ ...IDLE, targetKey: null })
const REENABLING_SNAPSHOT: SkillFreshnessSnapshot = Object.freeze({
  ...IDLE,
  targetKey: null,
  loading: true
})
const subscribers = new Set<() => void>()
let pendingReenableRefresh: Promise<void> | null = null

function publishSnapshot(next: SkillFreshnessSnapshot): void {
  if (
    snapshot.targetKey === next.targetKey &&
    snapshot.plan === next.plan &&
    snapshot.unsupported === next.unsupported &&
    snapshot.loading === next.loading &&
    snapshot.error === next.error
  ) {
    return
  }
  snapshot = next
  for (const subscriber of subscribers) {
    subscriber()
  }
}

async function loadPlan(
  target: BundledSkillTarget,
  force: boolean
): Promise<BundledSkillPlanResult> {
  const targetKey = bundledSkillTargetKey(target)
  if (force) {
    invalidationRevision += 1
  }
  const targetRevision = invalidationRevision
  for (;;) {
    if (cachedPlan?.targetKey === targetKey && cachedPlan.revision >= targetRevision) {
      return cachedPlan.result
    }
    if (pendingPlan?.targetKey !== targetKey) {
      const requestRevision = invalidationRevision
      const request = planBundledSkillsOnTarget(target, {})
        .then((result) => {
          // Why per target: a late answer from the previous host must not satisfy this one.
          cachedPlan = {
            targetKey,
            result,
            revision:
              cachedPlan?.targetKey === targetKey
                ? Math.max(cachedPlan.revision, requestRevision)
                : requestRevision
          }
          lastCompletedScanAt = Date.now()
          return result
        })
        .finally(() => {
          if (pendingPlan?.request === request) {
            pendingPlan = null
          }
        })
      pendingPlan = { targetKey, request }
    }
    await pendingPlan.request
  }
}

/** Re-plan without going through the hook, for surfaces whose explicit refresh affordance
 *  must move the shared verdict. */
export function refreshSkillFreshness(force = true): Promise<void> {
  return refreshPlan(force)
}

async function refreshPlan(force: boolean): Promise<void> {
  if (scheduledFocusRescan !== null) {
    window.clearTimeout(scheduledFocusRescan)
    scheduledFocusRescan = null
  }
  const target = activeTarget
  if (!target) {
    return
  }
  const targetKey = bundledSkillTargetKey(target)
  const sequence = ++refreshSequence
  // Why: the plan's digest is what Update executes. Once invalidated, a stale plan must
  // stop authorizing UI even if the replacement plan fails.
  publishSnapshot({ ...IDLE, targetKey, loading: true })
  try {
    const result = await loadPlan(target, force)
    if (sequence === refreshSequence) {
      publishSnapshot(
        result.kind === 'plan'
          ? { ...IDLE, targetKey, plan: result.plan }
          : { ...IDLE, targetKey, unsupported: result.reason }
      )
    }
  } catch (cause) {
    if (sequence === refreshSequence) {
      publishSnapshot({
        ...IDLE,
        targetKey,
        error: cause instanceof Error ? cause.message : 'Could not inspect Orca skills.'
      })
    }
  }
}

/** Points every surface at `target`; a new host drops the old one's plan and re-plans. */
function selectSkillFreshnessTarget(target: BundledSkillTarget): boolean {
  if (activeTarget && bundledSkillTargetKey(activeTarget) === bundledSkillTargetKey(target)) {
    return false
  }
  activeTarget = target
  void refreshPlan(true)
  return true
}

function onWindowFocus(): void {
  const cooldownRemaining = FOCUS_RESCAN_COOLDOWN_MS - (Date.now() - lastCompletedScanAt)
  if (cooldownRemaining <= 0) {
    void refreshPlan(true)
    return
  }
  if (
    !snapshot.plan ||
    !summarizeBundledSkillPlan(snapshot.plan).hasWork ||
    scheduledFocusRescan !== null
  ) {
    return
  }
  // Why: a focus event can follow an external edit. Retract stale update
  // authority immediately, but keep rapid alt-tabs to one trailing disk scan.
  publishSnapshot({ ...IDLE, targetKey: snapshot.targetKey, loading: true })
  scheduledFocusRescan = window.setTimeout(
    () => {
      scheduledFocusRescan = null
      void refreshPlan(true)
    },
    Math.min(cooldownRemaining, FOCUS_RESCAN_COOLDOWN_MS)
  )
}

function onInstalledSkillsChanged(): void {
  void refreshPlan(true)
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  if (subscribers.size === 1) {
    // Why: every consumer reads one external snapshot, so focus/install events
    // install one listener and trigger one shared plan regardless of UI count.
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onInstalledSkillsChanged)
  }
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onInstalledSkillsChanged)
      if (scheduledFocusRescan !== null) {
        window.clearTimeout(scheduledFocusRescan)
        scheduledFocusRescan = null
      }
    }
  }
}

function subscribeDisabled(): () => void {
  return () => {}
}

function getSnapshot(): SkillFreshnessSnapshot {
  return snapshot
}

function getDisabledSnapshot(): SkillFreshnessSnapshot {
  return DISABLED_SNAPSHOT
}

function ensurePlanLoaded(): void {
  if (!snapshot.plan && !snapshot.unsupported && !snapshot.loading) {
    void refreshPlan(false)
  }
}

export type SkillFreshnessState = SkillFreshnessSnapshot & {
  refresh: () => Promise<void>
}

async function skipSkillFreshnessRefresh(): Promise<void> {}

function refreshSkillFreshnessAfterReenable(): Promise<void> {
  pendingReenableRefresh ??= refreshPlan(true).finally(() => {
    pendingReenableRefresh = null
  })
  return pendingReenableRefresh
}

/** Plans `target`'s Orca skills; null (host unknown or not plannable) plans nothing. */
export function useSkillFreshness(target: BundledSkillTarget | null): SkillFreshnessState {
  const targetKey = target ? bundledSkillTargetKey(target) : null
  const previousKeyRef = useRef(targetKey)
  const reenabled = targetKey !== null && previousKeyRef.current === null
  const current = useSyncExternalStore(
    target ? subscribe : subscribeDisabled,
    target ? getSnapshot : getDisabledSnapshot,
    target ? getSnapshot : getDisabledSnapshot
  )

  useEffect(() => {
    const previousKey = previousKeyRef.current
    previousKeyRef.current = targetKey
    if (!target) {
      return
    }
    if (selectSkillFreshnessTarget(target)) {
      return
    }
    if (previousKey === null) {
      void refreshSkillFreshnessAfterReenable()
      return
    }
    ensurePlanLoaded()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `targetKey` is the target's identity.
  }, [targetKey])

  return {
    ...(reenabled || (target && current.targetKey !== targetKey) ? REENABLING_SNAPSHOT : current),
    refresh: target ? refreshSkillFreshness : skipSkillFreshnessRefresh
  }
}

export const _skillFreshnessCacheForTests = {
  reset(): void {
    activeTarget = null
    cachedPlan = null
    pendingPlan = null
    invalidationRevision = 0
    lastCompletedScanAt = 0
    refreshSequence = 0
    pendingReenableRefresh = null
    if (scheduledFocusRescan !== null) {
      window.clearTimeout(scheduledFocusRescan)
      scheduledFocusRescan = null
    }
    snapshot = { ...IDLE, targetKey: null }
  }
}
