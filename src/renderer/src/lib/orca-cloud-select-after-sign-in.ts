// Signing in from the Run-on picker's Orca Cloud row should leave Orca Cloud selected. The recipe
// only appears once main sees the sign-in, so the pick leaves an intent the recipe list consumes.

/** An intent older than this belongs to an abandoned sign-in and is ignored. */
const INTENT_TTL_MS = 10 * 60_000

let requestedAt: number | null = null
let attempt = 0

/** Returns this sign-in attempt's token; only that attempt may cancel its own intent. */
export function requestOrcaCloudSelectionAfterSignIn(now = Date.now()): number {
  requestedAt = now
  return ++attempt
}

/** A stale attempt finishing late (timed out, superseded) must not cancel a newer one. */
export function cancelOrcaCloudSelectionAfterSignIn(token: number = attempt): void {
  if (token === attempt) {
    requestedAt = null
  }
}

/** The Orca Cloud recipe id to select now, consuming the intent; null when there's nothing to do. */
export function takeOrcaCloudSelectionAfterSignIn(
  recipes: readonly { id: string; provider?: string }[],
  now = Date.now()
): string | null {
  if (requestedAt === null) {
    return null
  }
  if (now - requestedAt > INTENT_TTL_MS) {
    requestedAt = null
    return null
  }
  const orcaCloud = recipes.find((recipe) => recipe.provider === 'orca-cloud')
  if (!orcaCloud) {
    return null
  }
  requestedAt = null
  return orcaCloud.id
}
