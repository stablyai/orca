// Orca Cloud setup session (NP-4 N1), renderer side: starts the one-tab browser setup, polls the
// session while it is open, and keeps the latest snapshot for the composer's setup panel
// (w2-lifecycle's seam reads it synchronously) and the setup tracker (np4-shell).
import { useAppStore } from '@/store'
import { onCloudSetupReturn } from './cloud-setup-return'
import type {
  CloudSetupNeed,
  CloudSetupSession,
  CloudSetupStartResult
} from '../../../../shared/orca-cloud-setup'

/** Poll every 2 s for the first 3 minutes, then every 10 s (spec A6). */
export const SETUP_FAST_POLL_MS = 2_000
export const SETUP_FAST_WINDOW_MS = 3 * 60_000
export const SETUP_SLOW_POLL_MS = 10_000

export type CloudSetupRowId = 'account' | 'team' | 'plan' | 'github'

/** One row of the setup panel; the same shape as the composer's CloudSetupStep for these ids. */
export type CloudSetupSnapshotStep = {
  id: CloudSetupRowId
  state: 'done' | 'needed' | 'active' | 'pending' | 'failed' | 'optional'
  detail?: string
}

export type CloudSetupSnapshot = {
  steps: CloudSetupSnapshotStep[]
  finished: boolean
  error?: { kind: string; detail?: string }
  team: CloudSetupSession['team']
  trial: CloudSetupSession['trial']
  plan: CloudSetupSession['plan']
}

/**
 * Session -> panel rows. Every required row is present (account, team, plan, github when asked),
 * because a snapshot replaces the composer's own rows. `detail` carries the team name, how the
 * plan is covered ('trial' | 'subscription' | 'checkout') and 'requested' for a pending GitHub
 * approval.
 */
export function snapshotFromSession(session: CloudSetupSession): CloudSetupSnapshot {
  const steps = session.steps.map((step): CloudSetupSnapshotStep => {
    const detail = step.id === 'team' ? (session.team?.name ?? step.detail) : step.detail
    return { id: step.id, state: step.state, ...(detail ? { detail } : {}) }
  })
  return {
    steps,
    finished: session.finished,
    ...(session.error ? { error: session.error } : {}),
    team: session.team,
    trial: session.trial,
    plan: session.plan
  }
}

type Entry = {
  snapshot: CloudSetupSnapshot | null
  startedAt: number
  timer: number | null
  inFlight: boolean
  gone: boolean
  /** The team the profile was switched to for this session (once). */
  switchedTo: string | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<(sessionId: string) => void>()

function emit(sessionId: string): void {
  for (const listener of listeners) {
    listener(sessionId)
  }
}

/** Latest known state of a session, or null before the first poll answers. */
export function getCloudSetupSnapshot(sessionId: string): CloudSetupSnapshot | null {
  return entries.get(sessionId)?.snapshot ?? null
}

export function subscribeCloudSetupSessions(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function schedule(sessionId: string, entry: Entry): void {
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer)
  }
  if (entry.gone || entry.snapshot?.finished) {
    entry.timer = null
    return
  }
  const delay =
    Date.now() - entry.startedAt < SETUP_FAST_WINDOW_MS ? SETUP_FAST_POLL_MS : SETUP_SLOW_POLL_MS
  entry.timer = window.setTimeout(() => void refreshCloudSetupSession(sessionId), delay)
}

/**
 * Setup chose or created a team in the browser: make it this profile's active team, so billing,
 * sandboxes and the composer's checks all read that team (O1: cloud work belongs to a team).
 */
async function followSetupTeam(entry: Entry, session: CloudSetupSession): Promise<void> {
  const orgId = session.team?.orgId
  if (!orgId || entry.switchedTo === orgId) {
    return
  }
  entry.switchedTo = orgId
  const state = useAppStore.getState()
  if (state.orcaProfileAuthStatus?.cloud?.activeOrgId !== orgId) {
    await state.selectOrcaProfileOrg(orgId)
  }
}

/** Polls now (the orca://cloud/setup/return link and window focus call this). */
export async function refreshCloudSetupSession(sessionId: string): Promise<void> {
  const entry = entries.get(sessionId) ?? watchCloudSetupSession(sessionId)
  if (entry.inFlight || entry.gone) {
    return
  }
  entry.inFlight = true
  try {
    const result = await window.api.orcaProfiles.cloudSetupGet({ sessionId })
    if (result.status === 'ok') {
      entry.snapshot = snapshotFromSession(result.session)
      await followSetupTeam(entry, result.session)
      emit(sessionId)
    } else if (result.status === 'not-found') {
      // Expired or another account's: stop polling; the composer falls back to its own rows.
      entry.gone = true
      entry.snapshot = null
      emit(sessionId)
    }
  } catch {
    // Offline or main busy: keep the last snapshot and try again on the next tick.
  } finally {
    entry.inFlight = false
    schedule(sessionId, entry)
  }
}

let disposeReturnLink: (() => void) | null = null

/** Starts polling a session (e.g. one restored from the on-disk draft after a restart). */
export function watchCloudSetupSession(sessionId: string): Entry {
  // The done page's orca://cloud/setup/return link polls at once instead of on the next tick.
  disposeReturnLink ??= onCloudSetupReturn((returned) => {
    if (entries.has(returned)) {
      void refreshCloudSetupSession(returned)
    }
  })
  let entry = entries.get(sessionId)
  if (!entry) {
    entry = {
      snapshot: null,
      startedAt: Date.now(),
      timer: null,
      inFlight: false,
      gone: false,
      switchedTo: null
    }
    entries.set(sessionId, entry)
    window.setTimeout(() => void refreshCloudSetupSession(sessionId), 0)
  }
  return entry
}

export function stopWatchingCloudSetupSession(sessionId: string): void {
  const entry = entries.get(sessionId)
  if (entry?.timer != null) {
    window.clearTimeout(entry.timer)
  }
  entries.delete(sessionId)
}

/**
 * What "Set up and start" got back: the session it opened, `cancelled` when the user cancelled the
 * sign-in (or it timed out, or a newer one replaced it), or null when setup couldn't open.
 */
export type CloudSetupSessionStart = { sessionId: string } | { cancelled: true } | null

/** "Set up and start": opens the one browser tab and starts polling. */
export async function startCloudSetupSession(request: {
  repo?: string
  needs: CloudSetupNeed[]
  chooseTeam?: boolean
}): Promise<CloudSetupSessionStart> {
  let result: CloudSetupStartResult
  try {
    result = await window.api.orcaProfiles.cloudSetupStart({
      ...(request.repo ? { repo: request.repo } : {}),
      needs: request.needs,
      ...(request.chooseTeam ? { chooseTeam: true } : {})
    })
  } catch {
    return null
  }
  if (result.status === 'cancelled') {
    // The user stopped the sign-in: nothing else may open a browser on their behalf.
    return { cancelled: true }
  }
  if (result.status !== 'opened') {
    return null
  }
  watchCloudSetupSession(result.sessionId)
  return { sessionId: result.sessionId }
}

/** The setup session still open in this window, for the plans dialog to join (T2 Compare plans). */
export function activeCloudSetupSessionId(): string | null {
  for (const [sessionId, entry] of entries) {
    if (!entry.gone && !entry.snapshot?.finished) {
      return sessionId
    }
  }
  return null
}

/** Test-only. */
export function resetCloudSetupSessionsForTests(): void {
  for (const sessionId of entries.keys()) {
    stopWatchingCloudSetupSession(sessionId)
  }
  listeners.clear()
  disposeReturnLink?.()
  disposeReturnLink = null
}
