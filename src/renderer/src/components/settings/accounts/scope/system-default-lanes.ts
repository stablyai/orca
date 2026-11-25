import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderAccountSelection } from '@/runtime/provider-accounts/observations/runtime-provider-account-selection'
import {
  getProviderAccountRuntime,
  providerAccountIsActiveInView,
  type ProviderAccountRuntimeView
} from '../../../provider-accounts/provider-account-visibility'
import type { ProviderAccountAction } from '../accounts-pane-types'

type Account = Parameters<typeof getProviderAccountRuntime>[0]
type Selection = Parameters<typeof providerAccountIsActiveInView>[1]
type Lane = { runtime: 'host' | 'wsl'; wslDistro: string | null }

/** Lanes the pane's single "System default" must clear for the shown view. */
export function getSystemDefaultLanes(
  view: ProviderAccountRuntimeView,
  visibleAccounts: readonly Account[],
  selection: Selection,
  remoteOwner: boolean
): Lane[] {
  const lanes: Lane[] = [{ runtime: view.runtime, wslDistro: view.wslDistro ?? null }]
  if (!remoteOwner || view.runtime !== 'host') {
    return lanes
  }
  // A remote Windows roster shows WSL rows beside host ones, so their active lanes must clear too.
  const wslDistros = new Set<string | null>()
  for (const account of visibleAccounts) {
    const lane = getProviderAccountRuntime(account)
    if (
      lane.runtime === 'wsl' &&
      providerAccountIsActiveInView(account, selection, lane, { remoteOwner: true })
    ) {
      wslDistros.add(lane.wslDistro)
    }
  }
  return [
    ...lanes,
    ...Array.from(wslDistros, (wslDistro) => ({ runtime: 'wsl' as const, wslDistro }))
  ]
}

/** Remote Claude has no targeted select, so its WSL lanes cannot go back to System default. */
export function systemDefaultBlockedForClaude(
  lanes: readonly Lane[],
  remoteOwner: boolean
): boolean {
  return remoteOwner && lanes.some((lane) => lane.runtime === 'wsl')
}

/** Runs one System default select per lane, each through the pane's runner for its own restart diff. */
export async function runSystemDefaultSelect<T>(
  lanes: readonly Lane[],
  owner: RuntimeClientTarget,
  run: (
    action: ProviderAccountAction,
    operation: () => Promise<T>,
    actionRuntime: ProviderAccountRuntimeView
  ) => Promise<void>,
  select: (owner: RuntimeClientTarget, selection: ProviderAccountSelection) => Promise<T>
): Promise<void> {
  for (const lane of lanes) {
    await run('select:system', () => select(owner, { accountId: null, ...lane }), lane)
  }
}
