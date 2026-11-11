// JA-21, behind a flag Neil can veto (off unless the account's capabilities turn it on): the
// composer's Run on preflight. An owner or admin whose team can't start a sandbox right now (out of
// hours, payment failed, plan ended) sees Orca Cloud disabled in place, with the reason and the one
// fix, instead of picking it and hitting the wall after Start. Members already get "Ask an owner or
// admin". A plan not started yet (trial offer) is setup, not a wall, so it stays pickable.
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getOrcaCloudPick,
  type OrcaCloudRunTargetAccess
} from '@/components/new-workspace/orca-cloud-run-target-access'

export const RUN_ON_PREFLIGHT_CAPABILITY = 'runOnPreflight'
/** Dev/QA override for the harnesses: localStorage['orca:dev:runOnPreflight'] = '1'. */
const DEV_OVERRIDE_KEY = 'orca:dev:runOnPreflight'

function devOverride(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEV_OVERRIDE_KEY) === '1'
  } catch {
    return false
  }
}

export function useRunOnPreflightEnabled(): boolean {
  const capability = useAppStore((state) => {
    const status = state.orcaProfileAuthStatus
    return status?.state === 'connected'
      ? status.capabilities?.flags[RUN_ON_PREFLIGHT_CAPABILITY] === true
      : false
  })
  return capability || devOverride()
}

/** An owner or admin must fix billing before a sandbox can start: the row offers that fix. */
export function orcaCloudNeedsFixFirst(access: OrcaCloudRunTargetAccess): boolean {
  switch (access.state) {
    case 'out-of-hours':
    case 'payment-issue':
      return access.canManageBilling
    case 'no-plan':
      return access.canManageBilling && access.lapsed
    case 'loading':
    case 'unknown':
    case 'entitled':
    case 'signed-out':
      return false
  }
}

export type OrcaCloudWallNotice = {
  /** "Out of sandbox hours", "Payment failed", "Your Team plan ended", … */
  reason: string
  /** The one fix, for owners and admins; members are told who can fix it instead. */
  action: { label: string; run: () => void } | null
}

const ROW_COPY = 'auto.components.new.workspace.RunTargetCombobox'

/**
 * JA-21b: Orca Cloud is already the selected target (a remembered default) and a billing wall
 * applies. The composer keeps the selection, says why under Run on, and holds Create until fixed.
 */
export function orcaCloudWallNotice(access: OrcaCloudRunTargetAccess): OrcaCloudWallNotice | null {
  let reason: string
  let actionLabel: string
  switch (access.state) {
    case 'out-of-hours':
      reason =
        access.cause === 'cap'
          ? translate(`${ROW_COPY}.orcaCloudCapReached`, 'Spend cap reached')
          : translate(`${ROW_COPY}.orcaCloudOutOfHours`, 'Out of sandbox hours')
      actionLabel =
        access.cause === 'cap'
          ? translate(`${ROW_COPY}.orcaCloudRaiseSpendCap`, 'Raise spend cap')
          : translate(`${ROW_COPY}.orcaCloudTurnOnOverage`, 'Turn on overage')
      break
    case 'payment-issue':
      reason = translate(`${ROW_COPY}.orcaCloudPaymentFailed`, 'Payment failed')
      actionLabel = translate(`${ROW_COPY}.orcaCloudUpdatePaymentMethod`, 'Update payment method')
      break
    case 'no-plan':
      if (!access.lapsed) {
        return null
      }
      reason = translate(`${ROW_COPY}.orcaCloudPlanEnded`, 'Your Team plan ended')
      actionLabel = translate(`${ROW_COPY}.orcaCloudRenew`, 'Renew')
      break
    case 'loading':
    case 'unknown':
    case 'entitled':
    case 'signed-out':
      return null
  }
  const pick = getOrcaCloudPick(access)
  return {
    reason,
    action: pick.kind === 'act' ? { label: actionLabel, run: pick.run } : null
  }
}

/** Dev/QA only: localStorage['orca:dev:billingFault'] = 'out-of-hours' | 'payment-issue' | 'lapsed'. */
export function devBillingFaultAccess(): OrcaCloudRunTargetAccess | null {
  if (!import.meta.env.DEV) {
    return null
  }
  let fault: string | null = null
  try {
    fault = globalThis.localStorage?.getItem('orca:dev:billingFault') ?? null
  } catch {
    return null
  }
  return (fault && DEV_BILLING_FAULTS.get(fault)) || null
}

const DEV_BILLING_FAULTS = new Map<string, OrcaCloudRunTargetAccess>([
  ['out-of-hours', { state: 'out-of-hours', cause: 'hours', canManageBilling: true }],
  ['payment-issue', { state: 'payment-issue', canManageBilling: true }],
  ['lapsed', { state: 'no-plan', lapsed: true, canManageBilling: true }]
])
