// One Create press on Orca Cloud is one intent, and one intent makes at most one server create, ever
// (P0, JA-01/PC-8). The intent travels from the composer through the setup page to the hidden
// auto-start; whichever path creates first consumes it, and every later attempt is dropped. Exit,
// Back and Cancel consume it without creating. The id doubles as the create's idempotency key.

import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'

type IntentState = 'pending' | 'consumed'

const intents = new Map<string, IntentState>()

/** `create:<uuid>`, within the server's Idempotency-Key format (8–128 of [A-Za-z0-9_.:-]). */
function newIntentId(): string {
  return `create:${createNonSecureContextUuid()}`
}

/** A fresh intent for one Create press. */
export function beginCloudCreateIntent(): string {
  const id = newIntentId()
  intents.set(id, 'pending')
  return id
}

/** True exactly once per intent: the caller may create now. Unknown or used intents are refused. */
export function consumeCloudCreateIntent(id: string | null | undefined): boolean {
  if (!id || intents.get(id) !== 'pending') {
    return false
  }
  intents.set(id, 'consumed')
  return true
}

/** Exit, Back or Cancel: the intent can never create. */
export function cancelCloudCreateIntent(id: string | null | undefined): void {
  if (id) {
    intents.set(id, 'consumed')
  }
}

export function isCloudCreateIntentPending(id: string | null | undefined): boolean {
  return id ? intents.get(id) === 'pending' : false
}

/**
 * The server backstop (create-speed's Idempotency-Key): the intent a create was started with is
 * armed for a while, and every creation launched under it sends the same key, so a re-fired start
 * gets back the first sandbox instead of a second one. An explicit Retry of the same creation is a
 * new attempt and gets its own suffix.
 */
const ARMED_FOR_MS = 10 * 60_000
let armed: { key: string; at: number } | null = null
const keyByCreation = new Map<string, { key: string; attempts: number }>()

/** The composer calls this right before it creates with an intent. */
export function armCloudCreateIdempotency(intentId: string, now: number = Date.now()): void {
  armed = { key: intentId, at: now }
}

/** The key to send for a creation's provision; null with no armed intent. */
export function cloudCreateIdempotencyKey(
  creationId: string,
  now: number = Date.now()
): string | null {
  const bound = keyByCreation.get(creationId)
  if (bound) {
    bound.attempts += 1
    return `${bound.key}:retry-${bound.attempts}`
  }
  if (!armed || now - armed.at > ARMED_FOR_MS) {
    return null
  }
  keyByCreation.set(creationId, { key: armed.key, attempts: 0 })
  return armed.key
}

/** Tests only. */
export function resetCloudCreateIntentsForTest(): void {
  intents.clear()
  armed = null
  keyByCreation.clear()
}

/**
 * The composer's primary on Orca Cloud. Never creates while a setup page is open; otherwise starts
 * one intent and either hands it to the setup page or creates with it, once.
 */
export function startCloudCreate({
  setupOpen,
  setupNeeded,
  openSetup,
  create
}: {
  setupOpen: boolean
  setupNeeded: boolean
  openSetup: (intentId: string) => void
  create: (intentId: string) => void
}): void {
  if (setupOpen) {
    return
  }
  const id = beginCloudCreateIntent()
  if (setupNeeded) {
    openSetup(id)
    return
  }
  if (consumeCloudCreateIntent(id)) {
    armCloudCreateIdempotency(id)
    create(id)
  }
}
