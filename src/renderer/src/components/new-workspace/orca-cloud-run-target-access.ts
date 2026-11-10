import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { useAppStore } from '@/store/index'
import {
  cancelOrcaCloudSelectionAfterSignIn,
  requestOrcaCloudSelectionAfterSignIn
} from '@/lib/orca-cloud-select-after-sign-in'

/** Signing in from the row selects Orca Cloud once main offers it (the recipe list reloads). */
function signInThenSelectOrcaCloud(): void {
  requestOrcaCloudSelectionAfterSignIn()
  void useAppStore
    .getState()
    .connectCurrentOrcaProfile()
    .then((result) => {
      if (result?.status !== 'connected') {
        cancelOrcaCloudSelectionAfterSignIn()
      }
    })
    .catch(cancelOrcaCloudSelectionAfterSignIn)
}

/**
 * What the Run-on picker knows about the account's Orca Cloud access.
 * - `loading`: the first billing read is in flight; picking waits briefly for it.
 * - `unknown`: billing unreachable or not signed in to billing; picking proceeds and the build reports.
 * - `signed-out`: the build offers Orca Cloud but nobody is signed in; picking starts sign-in.
 * - `entitled`: can start a sandbox; `remainingSeconds` is the included time left this window.
 * - `no-plan`: no active Team subscription (`lapsed` when one existed); routes to the plans page.
 * - `out-of-hours`: included hours are spent (`cause: 'hours'`) or the overage cap is (`'cap'`).
 * - `payment-issue`: a failed payment blocks new starts.
 * Out-of-hours and payment issues are actionable only by owners/admins (`canManageBilling`).
 */
export type OrcaCloudRunTargetAccess =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'signed-out' }
  | { state: 'entitled'; remainingSeconds: number }
  | { state: 'no-plan'; lapsed: boolean }
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
      remainingSeconds: Math.max(0, entitlement.remainingIncludedSeconds)
    }
  }
  const { canManageBilling } = entitlement
  switch (entitlement.reason) {
    case 'included_hours_exhausted':
      return { state: 'out-of-hours', cause: 'hours', canManageBilling }
    case 'overage_cap_reached':
      return { state: 'out-of-hours', cause: 'cap', canManageBilling }
    case 'payment_past_due':
    case 'payment_grace_expired':
      return { state: 'payment-issue', canManageBilling }
    case 'subscription_inactive':
      return { state: 'no-plan', lapsed: true }
    case 'no_subscription':
    case null:
      return { state: 'no-plan', lapsed: false }
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
      return { kind: 'act', run: () => openPlansPage('sandbox') }
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

/** Section id on the overage controls in Settings › Orca account, where the switch and cap live. */
export const ORCA_BILLING_OVERAGE_SECTION_ID = 'orca-billing-overage'

function openOverageSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({
    pane: 'orca-account',
    repoId: null,
    sectionId: ORCA_BILLING_OVERAGE_SECTION_ID
  })
  state.openSettingsPage()
}

/** Whole hours from 10 up, one decimal below so the last hours stay legible. */
export function getOrcaCloudHoursLeft(remainingSeconds: number): number {
  const hours = remainingSeconds / 3600
  if (hours >= 10) {
    return Math.floor(hours)
  }
  // The last few minutes read 0.1 rather than a misleading 0 while starts are still allowed.
  return remainingSeconds > 0 ? Math.max(0.1, Math.floor(hours * 10) / 10) : 0
}
