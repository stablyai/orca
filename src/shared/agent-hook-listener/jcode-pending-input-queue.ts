import { parsePaneKey } from '../stable-pane-id'

const PENDING_PER_PANE_MAX = 32
const PENDING_MAX = 128
const PENDING_BYTES_MAX = 256 * 1024
export const JCODE_PENDING_TTL_MS = 30_000

// Original transport input keeps replay under its own launch authority.
export type JcodeSessionInput = {
  body: unknown
  receivedAt: number
  isReplay?: boolean
  generation?: number
}

export type PendingEvent = {
  paneKey: string
  sessionId: string
  rootSessionId?: string
  eventName: string
  hookPayload: Record<string, unknown>
  input: JcodeSessionInput
  bytes: number
}

export function trimJcodePendingInputs(pending: PendingEvent[], now: number): PendingEvent[] {
  const counts = new Map<string, number>()
  let bytes = 0
  // Walk backwards: on every bound, retain the newest evidence.
  const retained = pending
    .toReversed()
    .filter((event) => {
      const count = counts.get(event.paneKey) ?? 0
      if (now - event.input.receivedAt >= JCODE_PENDING_TTL_MS || count >= PENDING_PER_PANE_MAX) {
        return false
      }
      counts.set(event.paneKey, count + 1)
      return true
    })
    .toReversed()
  for (const event of retained) {
    bytes += event.bytes
  }
  while (retained.length > PENDING_MAX || bytes > PENDING_BYTES_MAX) {
    const first = retained.shift()
    if (first) {
      bytes -= first.bytes
    }
  }
  return retained
}

function sameInput(left: JcodeSessionInput, right: JcodeSessionInput): boolean {
  return (
    left === right ||
    (left.body === right.body &&
      left.receivedAt === right.receivedAt &&
      left.isReplay === right.isReplay &&
      left.generation === right.generation)
  )
}

export function findJcodePendingInput(pending: PendingEvent[], input?: JcodeSessionInput): number {
  return input ? pending.findIndex((event) => sameInput(event.input, input)) : -1
}

function serializedBytes(body: unknown): number {
  const serialized = JSON.stringify(body)
  return serialized === undefined ? PENDING_BYTES_MAX + 1 : Buffer.byteLength(serialized, 'utf8')
}

export function bufferJcodePendingInput(
  pending: PendingEvent[],
  event: Omit<PendingEvent, 'bytes'>,
  now: number
): PendingEvent[] {
  try {
    const bytes = serializedBytes(event.input.body)
    if (bytes <= PENDING_BYTES_MAX) {
      return trimJcodePendingInputs([...pending, { ...event, bytes }], now)
    }
  } catch {
    // An unserializable input carries no replayable evidence.
  }
  return pending
}

export function moveJcodePendingInputs(
  pending: PendingEvent[],
  fromPaneKey: string,
  toPaneKey: string
): PendingEvent[] {
  const tabId = parsePaneKey(toPaneKey)?.tabId
  const moved = pending.map((event) => {
    if (event.paneKey !== fromPaneKey) {
      return event
    }
    const body = event.input.body
    let movedBody = body
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const rewritten: Record<string, unknown> = { ...body }
      if (Object.hasOwn(body, 'paneKey')) {
        rewritten.paneKey = toPaneKey
      }
      if (Object.hasOwn(body, 'tabId') && tabId !== undefined) {
        rewritten.tabId = tabId
      }
      movedBody = rewritten
    }
    return {
      ...event,
      paneKey: toPaneKey,
      input: { ...event.input, body: movedBody },
      bytes: serializedBytes(movedBody)
    }
  })
  // Moves preserve arrival times; reapply capacity without wall-clock expiry.
  return trimJcodePendingInputs(moved, moved[0]?.input.receivedAt ?? 0)
}
