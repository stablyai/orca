import type { ExecutionHostId, ParsedExecutionHost } from '../../../../shared/execution-host'

export type AddRepoBrowseAuthorityActions = {
  browseLocal: () => void
  browseRuntime: () => void
  browseSsh: (targetId: string) => void
}

export function runAddRepoHostAction(
  actionableHostId: ExecutionHostId | null,
  action: () => void
): void {
  if (actionableHostId) {
    action()
  }
}

export function routeAddRepoBrowse(
  host: ParsedExecutionHost | null,
  actions: AddRepoBrowseAuthorityActions
): void {
  if (host?.kind === 'runtime') {
    actions.browseRuntime()
    return
  }
  if (host?.kind === 'ssh') {
    actions.browseSsh(host.targetId)
    return
  }
  if (host?.kind === 'local') {
    actions.browseLocal()
  }
}
