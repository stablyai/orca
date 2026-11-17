// Orca Cloud setup session, renderer side: starts the one-tab browser setup, polls the
// session while it is open, and keeps the latest snapshot for the composer's setup panel
// (w2-lifecycle's seam reads it synchronously) and the setup tracker (np4-shell).
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { teamSwitchFailedCopy } from '@/components/sidebar/account-menu/switch-active-team'
import { onCloudSetupReturn } from './cloud-setup-return'
import type {
  CloudSetupNeed,
  CloudSetupSession,
  CloudSetupStartResult
} from '../../../../shared/orca-cloud-setup'

/** Poll every 2 s for the first 3 minutes, then every 10 s. */
export const SETUP_FAST_POLL_MS = 2_000
const SETUP_FAST_WINDOW_MS = 3 * 60_000
const SETUP_SLOW_POLL_MS = 10_000

type CloudSetupRowId = 'account' | 'team' | 'plan' | 'github'

/** One row of the setup panel; the same shape as the composer's CloudSetupStep for these ids. */
type CloudSetupSnapshotStep = {
  id: CloudSetupRowId
  /** 'loading': setup chose a team, but this device hasn't switched to it yet. */
  state: 'done' | 'needed' | 'active' | 'pending' | 'failed' | 'optional' | 'loading'
  detail?: string
}

type CloudSetupSnapshot = {
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
  /** The team the profile is confirmed on for this session (set only after the switch landed). */
  switchedTo: string | null
  /** A failed switch was reported once; later polls retry quietly. */
  switchFailureShown: boolean
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
  // A finished session keeps polling while its team switch is still owed, so the switch retries.
  if (entry.gone || (entry.snapshot?.finished && !teamSwitchPending(entry))) {
    entry.timer = null
    return
  }
  const delay =
    Date.now() - entry.startedAt < SETUP_FAST_WINDOW_MS ? SETUP_FAST_POLL_MS : SETUP_SLOW_POLL_MS
  entry.timer = window.setTimeout(() => void refreshCloudSetupSession(sessionId), delay)
}

/**
 * Setup chose or created a team in the browser: make it this profile's active team, so billing,
 * sandboxes and the composer's checks all read that team (cloud work belongs to a team). Recorded
 * only once the switch landed; a failed one is retried on the next poll.
 */
async function followSetupTeam(entry: Entry, session: CloudSetupSession): Promise<void> {
  const orgId = session.team?.orgId
  if (!orgId || entry.switchedTo === orgId) {
    return
  }
  const state = useAppStore.getState()
  if (state.orcaProfileAuthStatus?.cloud?.activeOrgId === orgId) {
    entry.switchedTo = orgId
    return
  }
  const result = await state.selectOrcaProfileOrg(orgId)
  if (result?.status === 'selected') {
    entry.switchedTo = orgId
    return
  }
  if (!entry.switchFailureShown) {
    entry.switchFailureShown = true
    toast.error(teamSwitchFailedCopy(result))
  }
}

/** True while setup's team isn't this device's active team yet (the switch is still owed). */
function teamSwitchPending(entry: Entry): boolean {
  const orgId = entry.snapshot?.team?.orgId
  return Boolean(orgId) && entry.switchedTo !== orgId
}

/**
 * Until the switch lands, the team row reads as still checking, so the page never reports "All
 * set" (and auto-starts) under the previous account.
 */
function holdTeamRow(snapshot: CloudSetupSnapshot): CloudSetupSnapshot {
  return {
    ...snapshot,
    steps: snapshot.steps.map((step) => (step.id === 'team' ? { ...step, state: 'loading' } : step))
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
      if (teamSwitchPending(entry)) {
        entry.snapshot = holdTeamRow(entry.snapshot)
      }
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
      switchedTo: null,
      switchFailureShown: false
    }
    entries.set(sessionId, entry)
    window.setTimeout(() => void refreshCloudSetupSession(sessionId), 0)
  }
  return entry
}

function stopWatchingCloudSetupSession(sessionId: string): void {
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
type CloudSetupSessionStart = { sessionId: string; url?: string } | { cancelled: true } | null

/** "Set up and start": opens the one browser tab and starts polling. */
export async function startCloudSetupSession(request: {
  repo?: string
  needs: CloudSetupNeed[]
  chooseTeam?: boolean
  openBrowser?: boolean
}): Promise<CloudSetupSessionStart> {
  let result: CloudSetupStartResult
  try {
    result = await window.api.orcaProfiles.cloudSetupStart({
      ...(request.repo ? { repo: request.repo } : {}),
      needs: request.needs,
      ...(request.chooseTeam ? { chooseTeam: true } : {}),
      ...(request.openBrowser === false ? { openBrowser: false } : {})
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
  return result.url
    ? { sessionId: result.sessionId, url: result.url }
    : { sessionId: result.sessionId }
}

/** The setup session still open in this window, for the plans dialog (Compare plans) to join. */
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
