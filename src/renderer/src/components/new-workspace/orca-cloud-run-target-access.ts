import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { useAppStore } from '@/store/index'
import { sandboxHoursLeft } from '@/components/billing/plan-billing-format'
import {
  cancelOrcaCloudSelectionAfterSignIn,
  requestOrcaCloudSelectionAfterSignIn
} from '@/lib/orca-cloud-select-after-sign-in'
import { requestOrcaCloudAfterCheckout } from '@/lib/orca-cloud-after-checkout'
import { classifyEntitlementDenial, isOrcaCloudTrial } from '../../../../shared/orca-billing'

/** Signing in from the row selects Orca Cloud once main offers it (the recipe list reloads). */
function signInThenSelectOrcaCloud(): void {
  const token = requestOrcaCloudSelectionAfterSignIn()
  void useAppStore
    .getState()
    .connectCurrentOrcaProfile()
    .then((result) => {
      if (result?.status !== 'connected') {
        cancelOrcaCloudSelectionAfterSignIn(token)
      }
    })
    .catch(() => cancelOrcaCloudSelectionAfterSignIn(token))
}

/** Paying from the row returns to this composer with Orca Cloud picked (see PlansDialogHost). */
function choosePlanThenSelectOrcaCloud(): void {
  requestOrcaCloudAfterCheckout({ kind: 'composer' })
  openPlansPage('sandbox')
}

/**
 * What the Run-on picker knows about the account's Orca Cloud access.
 * - `loading`: the first billing read is in flight; picking waits briefly for it.
 * - `unknown`: billing unreachable or not signed in to billing; picking proceeds and the build reports.
 * - `signed-out`: the build offers Orca Cloud but nobody is signed in; picking starts sign-in.
 * - `entitled`: can start a sandbox; `remainingSeconds` is the included time left this window
 *   (`trial` while those are the team's one-time trial hours).
 * - `no-plan`: no active Team subscription (`lapsed` when one existed); routes owners/admins to the
 *   plans page and, once paid, back to the composer with Orca Cloud picked. `trialUsedUp` when the
 *   team's trial ran out; `trialOfferSeconds` when the team can still get its trial.
 * - `out-of-hours`: included hours are spent (`cause: 'hours'`) or the overage cap is (`'cap'`).
 * - `payment-issue`: a failed payment blocks new starts.
 * No plan, out-of-hours and payment issues are actionable only by owners/admins (`canManageBilling`).
 */
export type OrcaCloudRunTargetAccess =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'signed-out' }
  | {
      state: 'entitled'
      remainingSeconds: number
      /** Set only during the trial, whose low-hours warning names who can choose a plan (T1). */
      trial?: boolean
      canManageBilling?: boolean
    }
  | {
      state: 'no-plan'
      lapsed: boolean
      canManageBilling: boolean
      trialUsedUp?: boolean
      trialOfferSeconds?: number | null
    }
  | { state: 'out-of-hours'; cause: 'hours' | 'cap'; canManageBilling: boolean }
  | { state: 'payment-issue'; canManageBilling: boolean }

export function toOrcaCloudRunTargetAccess(
  result: OrcaBillingStatusResult | null
): OrcaCloudRunTargetAccess {
  if (result?.status !== 'ok') {
    return { state: 'unknown' }
  }
  const { entitlement } = result
  if (entitlement.canStartSandbox) {
    return {
      state: 'entitled',
      remainingSeconds: Math.max(0, entitlement.remainingIncludedSeconds),
      ...(isOrcaCloudTrial(entitlement)
        ? { trial: true, canManageBilling: entitlement.canManageBilling }
        : {})
    }
  }
  const { canManageBilling } = entitlement
  switch (classifyEntitlementDenial(entitlement.reason)) {
    case 'hours':
      return { state: 'out-of-hours', cause: 'hours', canManageBilling }
    case 'spendCap':
      return { state: 'out-of-hours', cause: 'cap', canManageBilling }
    case 'payment':
      return { state: 'payment-issue', canManageBilling }
    // Billing's account answer never carries the start-gate reasons; anything else is no plan,
    // which the plan fixes.
    case 'plan':
    case 'teamLimit':
    case 'memberLimit':
    case 'machineSize':
    case 'other':
      return {
        state: 'no-plan',
        lapsed: entitlement.reason === 'subscription_inactive',
        canManageBilling,
        ...(entitlement.reason === 'trial_used_up' ? { trialUsedUp: true } : {}),
        ...(entitlement.offers?.trial
          ? { trialOfferSeconds: entitlement.offers.trial.includedSeconds }
          : {})
      }
  }
}

/**
 * What picking Orca Cloud does for this access:
 * - `select`: commit it (entitled, or unknown, where the build reports any problem).
 * - `act`: run the fix instead of a build that would only fail (sign in, plans, overage, payment).
 * - `blocked`: a member can't fix it; the row and hint say who can, and picking does nothing.
 */
export type OrcaCloudPick =
  | { kind: 'select' }
  | { kind: 'act'; run: () => void }
  | { kind: 'blocked' }

export function getOrcaCloudPick(access: OrcaCloudRunTargetAccess): OrcaCloudPick {
  switch (access.state) {
    case 'signed-out':
      return { kind: 'act', run: signInThenSelectOrcaCloud }
    case 'no-plan':
      return access.canManageBilling
        ? { kind: 'act', run: choosePlanThenSelectOrcaCloud }
        : { kind: 'blocked' }
    case 'out-of-hours':
      return access.canManageBilling
        ? { kind: 'act', run: openOverageSettings }
        : { kind: 'blocked' }
    case 'payment-issue':
      return access.canManageBilling
        ? { kind: 'act', run: () => void window.api.orcaProfiles.billingOpenPortal() }
        : { kind: 'blocked' }
    case 'loading':
    case 'unknown':
    case 'entitled':
      return { kind: 'select' }
  }
}

/** Section id on the overage controls in Settings › Orca Cloud › Plan & billing (switch and cap). */
export const ORCA_BILLING_OVERAGE_SECTION_ID = 'orca-billing-overage'

function openOverageSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({
    pane: 'cloud-billing',
    repoId: null,
    sectionId: ORCA_BILLING_OVERAGE_SECTION_ID
  })
  state.openSettingsPage()
}

/** Hours left in tenths, rounded down: the one rule shared with Plan & billing. */
export function getOrcaCloudHoursLeft(remainingSeconds: number): number {
  // Why: the same rounding as Plan & billing and the account menu, so every surface agrees (JA-07).
  return sandboxHoursLeft(remainingSeconds)
}

/** Whether a create on Orca Cloud can start now (or may: still loading or unknown). */
export function orcaCloudCanStart(access: OrcaCloudRunTargetAccess | undefined): boolean {
  if (!access) {
    return true
  }
  switch (access.state) {
    case 'signed-out':
    case 'no-plan':
    case 'out-of-hours':
    case 'payment-issue':
      return false
    case 'loading':
    case 'unknown':
    case 'entitled':
      return true
  }
}
