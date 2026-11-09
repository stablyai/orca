import { useMemo } from 'react'
import type { OrcaBillingStatusResult } from '../../../../shared/orca-billing'
import { useOrcaBillingStatus } from '@/components/billing/use-orca-billing-status'
import { openPlansPage } from '@/components/billing/plans/plans-page-store'
import { useAppStore } from '@/store/index'

/**
 * What the Run-on picker knows about the account's Orca Cloud access.
 * - `unknown`: still loading, signed out, or billing unreachable; selection stays allowed and the build reports.
 * - `signed-out`: the build offers Orca Cloud but nobody is signed in; picking starts sign-in.
 * - `entitled`: can start a sandbox; `remainingSeconds` is the included time left this window.
 * - `no-plan`: no active Team subscription (`lapsed` when one existed); routes to the plans page.
 * - `out-of-hours`: included hours (and any overage cap) are spent; routes to plan & billing settings.
 * - `payment-issue`: a failed payment blocks new starts; routes to plan & billing settings.
 */
export type OrcaCloudRunTargetAccess =
  | { state: 'unknown' }
  | { state: 'signed-out' }
  | { state: 'entitled'; remainingSeconds: number }
  | { state: 'no-plan'; lapsed: boolean }
  | { state: 'out-of-hours'; canManageBilling: boolean }
  | { state: 'payment-issue'; canManageBilling: boolean }

export const UNKNOWN_ORCA_CLOUD_ACCESS: OrcaCloudRunTargetAccess = { state: 'unknown' }

export function toOrcaCloudRunTargetAccess(
  result: OrcaBillingStatusResult | null
): OrcaCloudRunTargetAccess {
  if (result?.status !== 'ok') {
    return UNKNOWN_ORCA_CLOUD_ACCESS
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
    case 'overage_cap_reached':
      return { state: 'out-of-hours', canManageBilling }
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
 * Where a blocked account goes instead of a build that would only fail, or null when picking may
 * proceed. Plans for no plan; plan & billing settings (overage, payment) otherwise.
 */
export function orcaCloudBlockedAction(access: OrcaCloudRunTargetAccess): (() => void) | null {
  switch (access.state) {
    case 'signed-out':
      return () => void useAppStore.getState().connectCurrentOrcaProfile()
    case 'no-plan':
      return () => openPlansPage('sandbox')
    case 'out-of-hours':
    case 'payment-issue':
      return openPlanBillingSettings
    case 'entitled':
    case 'unknown':
      return null
  }
}

function openPlanBillingSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'orca-account', repoId: null })
  state.openSettingsPage()
}

/** Whole hours from 10 up, one decimal below so the last hours stay legible. */
export function formatOrcaCloudHoursLeft(remainingSeconds: number): string {
  const hours = remainingSeconds / 3600
  if (hours >= 10) {
    return String(Math.floor(hours))
  }
  return (Math.floor(hours * 10) / 10).toFixed(1)
}

/** Reads billing only while `enabled` (picker open with Orca Cloud on offer), so composing never polls it. */
export function useOrcaCloudRunTargetAccess(enabled: boolean): OrcaCloudRunTargetAccess {
  const { result } = useOrcaBillingStatus(enabled)
  return useMemo(() => toOrcaCloudRunTargetAccess(result), [result])
}
