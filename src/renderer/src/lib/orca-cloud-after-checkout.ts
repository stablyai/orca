// Choosing a plan from an Orca Cloud wall should land back on the work, not on the Team page:
// the Run-on picker returns to its open composer with Orca Cloud picked, and a build card that
// was refused for no plan retries that create. Like signInThenSelectOrcaCloud, the wall leaves
// an intent that the plans dialog consumes once Checkout reports paid.

/** An intent older than this belongs to an abandoned Checkout and is ignored. */
const INTENT_TTL_MS = 30 * 60_000

export type OrcaCloudCheckoutIntent =
  /** From the Run-on picker: select Orca Cloud in the composer. */
  | { kind: 'composer' }
  /** From a build card refused for no plan: retry that pending creation. */
  | { kind: 'retry'; creationId: string }

/** Where a paid Checkout lands. */
export type OrcaCloudCheckoutReturn =
  /** No intent: the Team page's one-time "You're on Team" confirmation. */
  | { kind: 'team-page' }
  /** The composer that asked is still open: pick Orca Cloud in it. */
  | { kind: 'select-in-composer' }
  /** The composer closed meanwhile: reopen it on Orca Cloud. */
  | { kind: 'open-composer' }
  | { kind: 'retry'; creationId: string }

let pending: { intent: OrcaCloudCheckoutIntent; requestedAt: number } | null = null

export function requestOrcaCloudAfterCheckout(
  intent: OrcaCloudCheckoutIntent,
  now = Date.now()
): void {
  pending = { intent, requestedAt: now }
}

/** Closing the plans page without paying drops the intent. */
export function cancelOrcaCloudAfterCheckout(): void {
  pending = null
}

/** Consumes the intent and says where a paid Checkout should land. */
export function takeOrcaCloudCheckoutReturn(
  context: {
    /** The new-workspace composer is the active modal. */
    composerOpen: boolean
    /** The creation still exists (not dismissed while paying). */
    hasCreation: (creationId: string) => boolean
  },
  now = Date.now()
): OrcaCloudCheckoutReturn {
  const taken = pending
  pending = null
  if (!taken || now - taken.requestedAt > INTENT_TTL_MS) {
    return { kind: 'team-page' }
  }
  const { intent } = taken
  if (intent.kind === 'retry' && context.hasCreation(intent.creationId)) {
    return { kind: 'retry', creationId: intent.creationId }
  }
  return context.composerOpen ? { kind: 'select-in-composer' } : { kind: 'open-composer' }
}

type Listener = () => void
const listeners = new Set<Listener>()

/** The open composer's recipe list listens so a paid Checkout can pick Orca Cloud in it. */
export function onOrcaCloudCheckoutReturn(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitOrcaCloudCheckoutReturn(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Test seam. */
export function resetOrcaCloudAfterCheckout(): void {
  pending = null
  listeners.clear()
}
