// Signed in on the personal account while a team the user is on already has a plan. Offer
// "Switch to <team>" (the account menu's switcher, no browser trip) instead of a purchase.
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getOrcaAccountKey } from '@/hooks/use-orca-account-key'
import {
  ORCA_BILLING_TEAM_PLANS_MAX_ORGS,
  type OrcaBillingTeamPlan,
  type OrcaBillingTeamPlansResult
} from '../../../../../shared/orca-billing'
import type { OrcaProfileAuthStatus } from '../../../../../shared/orca-profiles/orca-profiles'

export type PlannedTeam = { orgId: string; name: string; planLabel: string | null }

/** Teams worth switching to: on a plan and able to start a sandbox now. Listed order kept. */
export function plannedTeamsFrom(
  status: OrcaProfileAuthStatus | null,
  teams: readonly OrcaBillingTeamPlan[]
): PlannedTeam[] {
  const byId = new Map(teams.map((team) => [team.orgId, team]))
  return (status?.organizations ?? []).flatMap((org) => {
    const team = byId.get(org.orgId)
    return team && team.plan !== null && team.canStartSandbox
      ? [{ orgId: org.orgId, name: org.name, planLabel: team.planLabel }]
      : []
  })
}

/** The teams to ask about, or null when it doesn't apply (signed out, or already on a team). */
export function teamPlanLookupIds(status: OrcaProfileAuthStatus | null): string[] | null {
  if (status?.state !== 'connected' || !status.cloud || status.cloud.activeOrgId) {
    return null
  }
  const ids = (status.organizations ?? []).map((org) => org.orgId)
  return ids.length > 0 ? ids.slice(0, ORCA_BILLING_TEAM_PLANS_MAX_ORGS) : null
}

const FRESH_MS = 5 * 60_000
type CacheEntry = { at: number; read: Promise<OrcaBillingTeamPlan[]> }
// Per account key and team list; a team switch or a new membership asks again.
const cache = new Map<string, CacheEntry>()

function readTeamPlans(key: string, orgIds: string[]): Promise<OrcaBillingTeamPlan[]> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return hit.read
  }
  const lookup = globalThis.window?.api?.orcaProfiles?.billingTeamPlans
  const read: Promise<OrcaBillingTeamPlan[]> = lookup
    ? lookup({ orgIds })
        .then((result: OrcaBillingTeamPlansResult) => (result.status === 'ok' ? result.teams : []))
        .catch(() => [])
    : Promise.resolve([])
  cache.set(key, { at: Date.now(), read })
  // A failed or empty read isn't kept for long: retry on the next mount.
  void read.then((teams) => {
    if (teams.length === 0 && cache.get(key)?.read === read) {
      cache.delete(key)
    }
  })
  return read
}

/**
 * Teams the user could switch to so this workspace can start. Empty while loading, when it doesn't
 * apply, or when billing can't say (the panel then falls back to its usual team/plan rows).
 */
export function useSwitchToPlannedTeam(enabled: boolean): PlannedTeam[] {
  const status = useAppStore((state) => state.orcaProfileAuthStatus)
  const orgIds = useMemo(() => teamPlanLookupIds(status), [status])
  const key = orgIds ? `${getOrcaAccountKey(status)}|${orgIds.join(',')}` : null
  const [answer, setAnswer] = useState<{ key: string; teams: OrcaBillingTeamPlan[] } | null>(null)
  useEffect(() => {
    if (!enabled || !key || !orgIds) {
      return
    }
    let live = true
    void readTeamPlans(key, orgIds).then((teams) => {
      if (live) {
        setAnswer({ key, teams })
      }
    })
    return () => {
      live = false
    }
    // A new auth status object with the same teams re-runs this, served from the cache.
  }, [enabled, key, orgIds])
  return useMemo(
    () => (enabled && key && answer?.key === key ? plannedTeamsFrom(status, answer.teams) : []),
    [enabled, key, answer, status]
  )
}

/** Test seam. */
export function resetTeamPlansCache(): void {
  cache.clear()
}
