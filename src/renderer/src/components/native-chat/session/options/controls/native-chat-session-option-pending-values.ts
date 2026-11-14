import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'

/** A descriptor write in flight; its value shows until it settles. */
export type PendingPick = { id: string; value?: SessionOptionValue }

type QueuedPick = { descriptor: SessionOptionDescriptor; value: SessionOptionValue }

// Show pending picks in place while open; refusal restores the host snapshot.
export function withPendingValue(
  descriptor: SessionOptionDescriptor,
  pending: PendingPick | null
): SessionOptionDescriptor {
  if (pending?.id !== descriptor.id) {
    return descriptor
  }
  const { kind } = descriptor
  if (kind.type === 'select' && typeof pending.value === 'string') {
    return {
      ...descriptor,
      valueSource: 'dispatched',
      kind: { ...kind, currentValue: pending.value }
    }
  }
  if (kind.type === 'boolean' && typeof pending.value === 'boolean') {
    return {
      ...descriptor,
      valueSource: 'dispatched',
      kind: { ...kind, currentValue: pending.value }
    }
  }
  return descriptor
}

function matchesLiveValue(live: SessionOptionDescriptor, value: SessionOptionValue): boolean {
  return (
    live.valueSource !== 'unknown' &&
    live.valueSource !== 'default' &&
    live.kind.currentValue === value
  )
}

/** A terminal agent can't take a change mid-reply: picks wait here, shown in place, and apply once
 *  the reply finishes. Picking the live value again drops the wait instead of queueing a no-op. */
export function useQueuedSessionOptions(
  isWorking: boolean,
  live: readonly SessionOptionDescriptor[],
  apply: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
) {
  const [queued, setQueued] = useState<ReadonlyMap<string, QueuedPick>>(new Map())
  const applyRef = useRef(apply)
  useLayoutEffect(() => {
    applyRef.current = apply
  })
  useEffect(() => {
    if (isWorking || queued.size === 0) {
      return
    }
    for (const { descriptor, value } of queued.values()) {
      applyRef.current(descriptor, value)
    }
    setQueued(new Map())
  }, [isWorking, queued])
  const queue = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    const current = live.find((candidate) => candidate.id === descriptor.id) ?? descriptor
    setQueued((previous) => {
      const next = new Map(previous)
      if (matchesLiveValue(current, value)) {
        next.delete(descriptor.id)
      } else {
        next.set(descriptor.id, { descriptor: current, value })
      }
      return next
    })
  }
  const shown = (descriptor: SessionOptionDescriptor): SessionOptionDescriptor => {
    const pick = queued.get(descriptor.id)
    return pick
      ? withPendingValue(descriptor, { id: descriptor.id, value: pick.value })
      : descriptor
  }
  return { queued, queue, shown }
}
