// JA-21, behind a flag Neil can veto (off unless the account's capabilities turn it on): the
// composer's Run on preflight. An owner or admin whose team can't start a sandbox right now (out of
// hours, payment failed, plan ended) sees Orca Cloud disabled in place, with the reason and the one
// fix, instead of picking it and hitting the wall after Start. Members already get "Ask an owner or
// admin". A plan not started yet (trial offer) is setup, not a wall, so it stays pickable.
import { useAppStore } from '@/store'
import type { OrcaCloudRunTargetAccess } from '@/components/new-workspace/orca-cloud-run-target-access'

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
