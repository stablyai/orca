import type { AppState } from '@/store/types'

/** The distro of a WSL host whose last status says it stopped; null for any other host. */
export function selectStoppedWslDistro(
  state: Pick<AppState, 'wslHostStatuses'>,
  environmentId: string | null | undefined
): string | null {
  const status = environmentId ? state.wslHostStatuses[environmentId] : undefined
  return status?.state === 'distro-stopped' ? status.distro : null
}

/**
 * Whether a pane shows the stopped distro's Start card. A pane whose create failed has no server
 * yet and is still the workspace's; one on another server, or a host that cannot run, keeps its own
 * notice.
 */
export function paneShowsWslHostStoppedCard(args: {
  wslHostUnavailable: boolean
  stoppedWslDistro: string | null
  ownerEnvironmentId: string | null
  paneEnvironmentId: string | null | undefined
}): boolean {
  return (
    !args.wslHostUnavailable &&
    args.stoppedWslDistro !== null &&
    args.ownerEnvironmentId !== null &&
    (args.paneEnvironmentId == null || args.paneEnvironmentId === args.ownerEnvironmentId)
  )
}
