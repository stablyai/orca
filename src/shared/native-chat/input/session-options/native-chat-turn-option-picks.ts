import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../agent-launch/permissions/agent-chat-permission-mode-option-id'
import type { SessionOptionDescriptor, SessionOptionValue } from '../native-chat-session-options'

type TurnOptionPick = {
  value: SessionOptionValue
  /** The value in force when this option was first picked during the turn. */
  before: SessionOptionValue | undefined
}

/** Picks made while a turn runs, by option id, in pick order. */
export type NativeChatTurnOptionPicks = ReadonlyMap<string, TurnOptionPick>

export const NO_NATIVE_CHAT_TURN_OPTION_PICKS: NativeChatTurnOptionPicks = new Map()

/** Permission mode keeps its own next-turn caption. */
export function takesNativeChatTurnOptionPick(
  descriptor: SessionOptionDescriptor | undefined
): descriptor is SessionOptionDescriptor {
  return (
    descriptor !== undefined &&
    descriptor.settable &&
    !descriptor.action &&
    descriptor.id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
}

/** Replaces the option's earlier pick; picking back the value the turn started with clears it. */
export function withNativeChatTurnOptionPick(
  picks: NativeChatTurnOptionPicks,
  descriptor: SessionOptionDescriptor,
  value: SessionOptionValue
): NativeChatTurnOptionPicks {
  const next = new Map(picks)
  const before = picks.has(descriptor.id)
    ? picks.get(descriptor.id)?.before
    : descriptor.kind.currentValue
  next.delete(descriptor.id)
  if (value !== before) {
    next.set(descriptor.id, { value, before })
  }
  return next
}

function withValue(
  descriptor: SessionOptionDescriptor,
  value: SessionOptionValue
): SessionOptionDescriptor {
  const { kind } = descriptor
  if (kind.type === 'select' && typeof value === 'string') {
    return { ...descriptor, kind: { ...kind, currentValue: value } }
  }
  if (kind.type === 'boolean' && typeof value === 'boolean') {
    return { ...descriptor, kind: { ...kind, currentValue: value } }
  }
  return descriptor
}

/**
 * held: the lane keeps the pick until the turn ends, so it is shown in place of the live value.
 * sending: a held pick on its way after the turn, shown in place until the agent settles it.
 * noted: the lane already took the pick for the next turn, so only a live value matching it is marked.
 */
export function markNativeChatTurnOptionPicks(
  snapshot: SessionOptionDescriptor[],
  picks: NativeChatTurnOptionPicks,
  lane: 'held' | 'sending' | 'noted'
): SessionOptionDescriptor[] {
  if (picks.size === 0) {
    return snapshot
  }
  return snapshot.map((descriptor) => {
    const pick = picks.get(descriptor.id)
    if (!pick) {
      return descriptor
    }
    if (lane === 'held') {
      return { ...withValue(descriptor, pick.value), appliesAfterTurn: true }
    }
    if (lane === 'sending') {
      return withValue(descriptor, pick.value)
    }
    return descriptor.kind.currentValue === pick.value
      ? { ...descriptor, appliesAfterTurn: true }
      : descriptor
  })
}

export function hasNativeChatTurnOptionPick(snapshot: readonly SessionOptionDescriptor[]): boolean {
  return snapshot.some((descriptor) => descriptor.appliesAfterTurn === true)
}
