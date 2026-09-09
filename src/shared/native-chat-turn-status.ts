// Turn-status derivation and copy for the native-chat "Thinking / Working for N /
// Worked for N" row, shared by the desktop renderer (as its i18n fallback strings)
// and the mobile app (used directly — mobile ships English only) so the two
// surfaces never drift. Everything here is pure; each platform owns its own clock.

import type { NativeChatMessage } from './native-chat-types'

export const NATIVE_CHAT_TURN_STATUS_COPY = {
  thinking: 'Thinking',
  workingFor: 'Working for {{value0}}',
  workedFor: 'Worked for {{value0}}',
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

/** Which of the three copy keys a turn-status row renders, and its duration
 *  argument. Desktop maps this onto `translate`; mobile formats it directly. */
export function describeNativeChatTurnStatus({
  thinking,
  workedSeconds,
  elapsedSeconds
}: {
  thinking: boolean
  workedSeconds?: number | null
  elapsedSeconds: number
}): { key: 'thinking' | 'workingFor' | 'workedFor'; duration: string | null } {
  if (workedSeconds != null) {
    return { key: 'workedFor', duration: formatNativeChatDuration(workedSeconds) }
  }
  if (thinking) {
    return { key: 'thinking', duration: null }
  }
  return { key: 'workingFor', duration: formatNativeChatDuration(elapsedSeconds) }
}

/** Resolve the turn-status label in English. For platforms without i18n (mobile). */
export function formatNativeChatTurnStatusLabel(input: {
  thinking: boolean
  workedSeconds?: number | null
  elapsedSeconds: number
}): string {
  const { key, duration } = describeNativeChatTurnStatus(input)
  const copy = NATIVE_CHAT_TURN_STATUS_COPY[key]
  return duration == null ? copy : copy.replaceAll('{{value0}}', duration)
}

/** True once the current turn has produced anything renderable — the boundary
 *  between the "Thinking" label and the counting "Working for N" label. */
export function nativeChatTurnHasResponse(
  messages: readonly NativeChatMessage[],
  latestUserIndex: number
): boolean {
  return messages
    .slice(latestUserIndex + 1)
    .some(
      (message) =>
        (message.role === 'assistant' || message.role === 'tool') &&
        message.blocks.some(
          (block) =>
            block.type === 'tool-call' ||
            block.type === 'tool-result' ||
            (block.type === 'text' && block.text.trim().length > 0)
        )
    )
}

export type NativeChatTurnTiming = {
  startedAt: number
  workedSeconds: number | null
}

export type NativeChatTurnStatus = {
  startedAt: number | null
  thinking: boolean
  workedSeconds: number | null
}

export type NativeChatTurnTimingByTurn = Readonly<Record<string, NativeChatTurnTiming>>

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
    // An in-flight turn keeps the start it already had; only a fresh turn (or an
    // authoritative host timestamp) restamps it.
    const startedAt =
      workingStartedAt ?? (timing && timing.workedSeconds == null ? timing.startedAt : now)
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

/** Split the timing map into the active turn's status and the settled ones. */
export function selectNativeChatTurnStatuses(
  timingByTurn: NativeChatTurnTimingByTurn,
  {
    activeTurnKey,
    isWorking,
    workingStartedAt,
    hasCurrentTurnResponse
  }: {
    activeTurnKey: string
    isWorking: boolean
    workingStartedAt?: number | null
    hasCurrentTurnResponse: boolean
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
  return {
    active: isWorking
      ? {
          startedAt: workingStartedAt ?? timingByTurn[activeTurnKey]?.startedAt ?? null,
          thinking: !hasCurrentTurnResponse,
          workedSeconds: null
        }
      : (completedByTurn[activeTurnKey] ?? null),
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
