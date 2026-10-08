// Turn-status derivation and copy for the native-chat turn rows — the "Working for N /
// Worked for N" bar under the user's message and the live line at the turn's tail —
// shared by the desktop renderer (as its i18n fallback strings) and the mobile app
// (used directly — mobile ships English only) so the two surfaces never drift.
// Everything here is pure; each platform owns its own clock.

import type { AgentTurnOutcome } from './agent-turn-outcome'

export const NATIVE_CHAT_TURN_STATUS_COPY = {
  thinking: 'Thinking',
  working: 'Working…',
  stopping: 'Stopping…',
  /** The composer's placeholder while the chat reads Stopping, where the host queues sends. */
  queueAfterStop: 'Queue a message to run after the stop',
  /** The same where it does not: the host holds the send until the stop lands. */
  sendAfterStop: 'Send a message to run after the stop',
  workingFor: 'Working for {{value0}}',
  workedFor: 'Worked for {{value0}}',
  interruptedAfter: 'Interrupted after {{value0}}',
  failedAfter: 'Failed after {{value0}}',
  toggleDetails: 'Toggle turn details',
  responding: 'Agent is responding'
} as const

/** Format turn time without exposing an ever-growing raw seconds count. */
export function formatNativeChatDuration(seconds: number): string {
  const totalSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`
}

/** The turn bar's copy key and duration: the running clock, then the settled one.
 *  Desktop maps this onto `translate`; mobile formats it directly. */
export function describeNativeChatTurnStatus({
  workedSeconds,
  elapsedSeconds,
  verdict
}: {
  workedSeconds?: number | null
  elapsedSeconds: number
  /** How the settled turn ended: a user's Stop, a newer request's replacement, or a cut nobody
   *  asked for (Orca crashing or quitting, an eviction) reads interrupted, and a failure, the
   *  agent's own exit included, reads failed. Only the cut gets the chat's notice row saying why. */
  verdict?: AgentTurnOutcome
}): {
  key: 'workingFor' | 'workedFor' | 'interruptedAfter' | 'failedAfter'
  duration: string
} {
  return workedSeconds != null
    ? { key: settledTurnStatusKey(verdict), duration: formatNativeChatDuration(workedSeconds) }
    : { key: 'workingFor', duration: formatNativeChatDuration(elapsedSeconds) }
}

function settledTurnStatusKey(
  verdict: AgentTurnOutcome | undefined
): 'workedFor' | 'interruptedAfter' | 'failedAfter' {
  switch (verdict) {
    case 'cancellation':
    case 'superseded':
    case 'interruption':
      return 'interruptedAfter'
    case 'failure':
      return 'failedAfter'
    case 'success':
    case 'unconfirmed':
    case undefined:
      return 'workedFor'
  }
}

/** The two readings that label a live turn's tail line, carried together so a
 *  surface cannot pick up one without the other. */
export type NativeChatLiveTurnIndicator = {
  thinking: boolean
  activityText: string | null
  /** A person's Stop is ending the turn. */
  stopping?: boolean
  /** This client's own Stop request is in flight: only then does its Stop control hold. */
  stopRequestInFlight?: boolean
  /** While stopping: a message sent now is queued as a card where the host queues sends, else sent
   *  for the host to hold until the stop lands. */
  afterStop?: 'queue' | 'send'
}

export type NativeChatActiveTurnLabel =
  | { source: 'activity'; text: string }
  | { source: 'status'; key: 'thinking' | 'working' | 'stopping' }

/** The live tail line's label. The person's own Stop wins: whatever the turn was doing, it is
 *  now ending. Provider activity is next because it is the only text that says what the turn is
 *  actually doing; reasoning is next. It never carries the clock — the turn bar owns that.
 *  Shared so desktop and mobile cannot disagree. */
export function describeNativeChatActiveTurnLabel({
  activityText,
  thinking,
  stopping = false
}: {
  activityText?: string | null
  thinking: boolean
  stopping?: boolean
}): NativeChatActiveTurnLabel {
  if (stopping) {
    return { source: 'status', key: 'stopping' }
  }
  const text = activityText?.trim()
  if (text) {
    return { source: 'activity', text }
  }
  return { source: 'status', key: thinking ? 'thinking' : 'working' }
}

/** The live tail line's label in English. For platforms without i18n (mobile). */
export function formatNativeChatActiveTurnLabel(input: {
  activityText?: string | null
  thinking: boolean
  stopping?: boolean
}): string {
  const label = describeNativeChatActiveTurnLabel(input)
  return label.source === 'activity' ? label.text : NATIVE_CHAT_TURN_STATUS_COPY[label.key]
}

/** Resolve the turn bar's label in English. For platforms without i18n (mobile). */
export function formatNativeChatTurnStatusLabel(input: {
  workedSeconds?: number | null
  elapsedSeconds: number
  verdict?: AgentTurnOutcome
}): string {
  const { key, duration } = describeNativeChatTurnStatus(input)
  return NATIVE_CHAT_TURN_STATUS_COPY[key].replaceAll('{{value0}}', duration)
}

export type NativeChatTurnTiming = {
  startedAt: number
  workedSeconds: number | null
}

export type NativeChatTurnStatus = {
  startedAt: number | null
  thinking: boolean
  workedSeconds: number | null
  /** How a settled turn ended, when the host recorded it. */
  verdict?: AgentTurnOutcome
}

export type NativeChatTurnTimingByTurn = Readonly<Record<string, NativeChatTurnTiming>>

/** The live turn's key when the transcript has no user message to hang it on. */
export const NATIVE_CHAT_UNANCHORED_TURN_KEY = '__unanchored__'

/** The turn-timing state machine, lifted out of the React hook so desktop and
 *  mobile stamp start/stop identically. Returns the same reference when nothing
 *  changed so callers can bail out of a state update. */
export function reduceNativeChatTurnTiming(
  current: NativeChatTurnTimingByTurn,
  {
    activeTurnKey,
    previousActiveTurnKey,
    validTurnKeys,
    isWorking,
    workingStartedAt,
    now
  }: {
    activeTurnKey: string
    /** The key this turn had on the previous pass. When it names a turn that has
     *  since left the transcript, the two are the same turn under two ids — an
     *  optimistic echo that the transcript replaced — so the clock carries over
     *  instead of restarting. Omit it to keep the plain restart behavior. */
    previousActiveTurnKey?: string
    validTurnKeys: ReadonlySet<string>
    isWorking: boolean
    workingStartedAt?: number | null
    now: number
  }
): NativeChatTurnTimingByTurn {
  // The same turn under two ids: an optimistic echo the transcript has since
  // replaced. Re-key its timing so neither the running clock nor an already
  // settled duration is lost when the swap lands.
  const replacedTiming =
    previousActiveTurnKey !== undefined &&
    previousActiveTurnKey !== activeTurnKey &&
    !validTurnKeys.has(previousActiveTurnKey) &&
    current[activeTurnKey] === undefined
      ? current[previousActiveTurnKey]
      : undefined
  let retained = replacedTiming ? { ...current, [activeTurnKey]: replacedTiming } : current
  for (const turnKey of Object.keys(retained)) {
    if (turnKey !== activeTurnKey && !validTurnKeys.has(turnKey)) {
      if (retained === current) {
        retained = { ...current }
      }
      delete (retained as Record<string, NativeChatTurnTiming>)[turnKey]
    }
  }

  const timing = retained[activeTurnKey]
  if (isWorking) {
    // A lifecycle row can arrive before its exact request-origin revision. Keep
    // the earlier anchor so publication order can never run the live clock backward.
    const startedAt =
      timing && timing.workedSeconds == null
        ? workingStartedAt === null || workingStartedAt === undefined
          ? timing.startedAt
          : Math.min(timing.startedAt, workingStartedAt)
        : (workingStartedAt ?? now)
    if (timing?.startedAt === startedAt && timing.workedSeconds == null) {
      return retained
    }
    return { ...retained, [activeTurnKey]: { startedAt, workedSeconds: null } }
  }

  if (timing?.workedSeconds != null) {
    return retained
  }
  const startedAt = timing?.startedAt ?? workingStartedAt
  if (startedAt == null) {
    return retained
  }
  return {
    ...retained,
    [activeTurnKey]: {
      startedAt,
      workedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000))
    }
  }
}

/** A turn duration the execution host recorded, which outranks anything this
 *  platform observed locally. */
export type NativeChatSettledTurn = {
  startedAt: number
  workedSeconds: number
  verdict?: AgentTurnOutcome
}

/** Per turn: the host's duration, or null when the host recorded the turn but
 *  has no duration to show (still running, or its end was never observed).
 *  Either way the host's word replaces whatever this platform clocked locally. */
export type NativeChatSettledTurns = ReadonlyMap<string, NativeChatSettledTurn | null>

/** Split the timing map into the active turn's status and the settled ones.
 *  Host-recorded durations override the locally observed ones per turn; local
 *  observation remains the floor for hosts that record nothing. */
export function selectNativeChatTurnStatuses(
  timingByTurn: NativeChatTurnTimingByTurn,
  {
    activeTurnKey,
    isWorking,
    workingStartedAt,
    thinking,
    settledByTurn
  }: {
    activeTurnKey: string
    isWorking: boolean
    workingStartedAt?: number | null
    /** Whether the active turn is reasoning right now, from its journal content. */
    thinking: boolean
    settledByTurn?: NativeChatSettledTurns
  }
): { active: NativeChatTurnStatus | null; completedByTurn: Record<string, NativeChatTurnStatus> } {
  const completedByTurn = Object.fromEntries(
    Object.entries(timingByTurn)
      .filter(([, timing]) => timing.workedSeconds != null)
      .map(([turnKey, timing]) => [
        turnKey,
        { startedAt: timing.startedAt, thinking: false, workedSeconds: timing.workedSeconds }
      ])
  ) as Record<string, NativeChatTurnStatus>
  for (const [turnKey, settled] of settledByTurn ?? []) {
    if (settled === null) {
      delete completedByTurn[turnKey]
      continue
    }
    completedByTurn[turnKey] = {
      startedAt: settled.startedAt,
      thinking: false,
      workedSeconds: settled.workedSeconds,
      ...(settled.verdict ? { verdict: settled.verdict } : {})
    }
  }
  const activeTiming = timingByTurn[activeTurnKey]
  return {
    active: isWorking
      ? {
          startedAt: activeTiming?.startedAt ?? workingStartedAt ?? null,
          thinking,
          workedSeconds: null
        }
      : (completedByTurn[activeTurnKey] ??
        // Ended, but the local duration is stamped a pass later: stay live until then so
        // the bar settles in place instead of blinking out. The host's null still hides it.
        (activeTiming?.workedSeconds === null && !settledByTurn?.has(activeTurnKey)
          ? { startedAt: activeTiming.startedAt, thinking: false, workedSeconds: null }
          : null)),
    completedByTurn
  }
}

/** Elapsed whole seconds for a counting turn, tolerating a not-yet-stamped start. */
export function nativeChatElapsedSeconds(
  startedAt: number | null,
  fallbackStartedAt: number,
  now: number
): number {
  return Math.max(0, Math.floor((now - (startedAt ?? fallbackStartedAt)) / 1000))
}
