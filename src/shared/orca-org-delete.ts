// Deleting a team (TEAM-DELETE): auth's GET /v1/desktop/orgs/:orgId/delete-check and
// POST /v1/desktop/orgs/:orgId/delete. Owners only; auth refuses while the team still has a plan
// or any cloud workspace (running, asleep or archived). The delete never removes workspaces.

/** Why the team can't be deleted yet. Unknown codes from a newer auth are dropped. */
export type OrcaOrgDeleteBlocker =
  /** Any open subscription status (active, trialing, past_due, unpaid, incomplete, paused). */
  | { code: 'subscription_active'; status: string }
  /** Cloud workspaces in any state but destroyed. */
  | { code: 'workspaces_exist'; count: number }

export type OrcaProfileOrgDeleteCheckArgs = { orgId: string }

/** `confirmName` is the team name exactly as typed; auth compares it case-sensitively. */
export type OrcaProfileOrgDeleteArgs = { orgId: string; confirmName: string }

/**
 * `unavailable`: billing or sandbox-control couldn't be reached (503); nothing was checked or
 * deleted. `unsupported`: this auth deployment has no delete route yet.
 */
type OrcaOrgDeleteCommonStatus =
  | 'unconfigured'
  | 'reconnect-required'
  | 'forbidden'
  | 'unsupported'
  | 'rate-limited'
  | 'unavailable'

/**
 * EP-10: the team's plan is already set to end (cancel at period end). Deleting the team ends it
 * now; the rest of the period isn't refunded. `periodEnd` is when it would have ended (ISO 8601).
 */
export type OrcaOrgDeleteCancelsSubscription = { periodEnd: string }

export type OrcaProfileOrgDeleteCheckResult =
  | {
      status: 'ok'
      deletable: boolean
      blockers: OrcaOrgDeleteBlocker[]
      cancelsSubscription?: OrcaOrgDeleteCancelsSubscription
    }
  | { status: OrcaOrgDeleteCommonStatus }
  | { status: 'failed'; error: string }

export type OrcaProfileOrgDeleteResult =
  | { status: 'deleted' }
  /** 409 not_deletable: a blocker the pre-check missed. */
  | { status: 'blocked'; blockers: OrcaOrgDeleteBlocker[] }
  /** 400 confirm_mismatch. */
  | { status: 'confirm-mismatch' }
  /**
   * EP-10: the plan was already ended (that can't be undone), then the rest of the delete failed.
   * The team still exists, without a plan; deleting again is safe. `cause` is auth's original code.
   */
  | { status: 'failed-after-cancel'; cause: string }
  | { status: OrcaOrgDeleteCommonStatus }
  | { status: 'failed'; error: string }

export const ORCA_ORG_DELETE_CONFIRM_MAX_LENGTH = 256

/** EP-10: the desktop understands `cancelsSubscription` and `delete_failed_after_cancel`. */
export const ORCA_ORG_DELETE_SUPPORTS = 'cancel_on_delete'

/** A valid `cancelsSubscription` from auth, or undefined (anything malformed is ignored). */
export function normalizeOrgDeleteCancelsSubscription(
  value: unknown
): OrcaOrgDeleteCancelsSubscription | undefined {
  if (!isPlainRecord(value) || typeof value.periodEnd !== 'string') {
    return undefined
  }
  return Number.isNaN(Date.parse(value.periodEnd)) ? undefined : { periodEnd: value.periodEnd }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keeps the blockers this desktop knows how to explain. */
export function normalizeOrgDeleteBlockers(value: unknown): OrcaOrgDeleteBlocker[] {
  if (!Array.isArray(value)) {
    return []
  }
  const blockers: OrcaOrgDeleteBlocker[] = []
  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      continue
    }
    const record = entry
    if (record.code === 'subscription_active') {
      blockers.push({
        code: 'subscription_active',
        status: typeof record.status === 'string' ? record.status : 'active'
      })
    } else if (record.code === 'workspaces_exist') {
      const count =
        typeof record.count === 'number' && Number.isFinite(record.count)
          ? Math.max(1, Math.floor(record.count))
          : 1
      blockers.push({ code: 'workspaces_exist', count })
    }
  }
  return blockers
}
