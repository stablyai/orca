import type { ParsedExecutionHost } from '../../../../shared/execution-host'

export type AddRepoBrowseAuthorityActions = {
  browseLocal: () => void
  browseRuntime: () => void
  /** Set when the runtime host is a WSL host: Windows' own folder picker reaches its distro. */
  browseWslHost?: (() => void) | null
}

export function routeAddRepoBrowse(
  host: ParsedExecutionHost | null,
  actions: AddRepoBrowseAuthorityActions
): void {
  if (host?.kind === 'runtime') {
    if (actions.browseWslHost) {
      actions.browseWslHost()
      return
    }
    actions.browseRuntime()
    return
  }
  if (host?.kind === 'local') {
    actions.browseLocal()
  }
}
