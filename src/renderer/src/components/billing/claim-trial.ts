// Starts the team's one-time Orca Cloud trial (spec N11/B1): the first time anyone on a team that
// never had a plan or a trial picks Orca Cloud. Billing grants it at most once per team, user,
// email and GitHub identity; the answer lands in the shared billing cache so every surface agrees.
import type { OrcaBillingTrialClaimResult } from '../../../../shared/orca-billing'
import { getBillingGeneration, recordBillingStatusIfCurrent } from './billing-summary-store'

export async function claimOrcaCloudTrial(): Promise<OrcaBillingTrialClaimResult> {
  const generation = getBillingGeneration()
  const result = await window.api.orcaProfiles
    .billingClaimTrial()
    .catch((error: unknown): OrcaBillingTrialClaimResult => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }))
  if (result.status === 'ok') {
    recordBillingStatusIfCurrent(generation, { status: 'ok', entitlement: result.entitlement })
  }
  return result
}
