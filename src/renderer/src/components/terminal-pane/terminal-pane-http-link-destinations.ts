import { useAppStore } from '@/store'
import { httpLinkActionDestinationsFor } from '@/lib/http-link-destinations'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-tab-open'
import { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import type { TerminalHttpLinkActionDestinations } from './terminal-url-link-hit-testing'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'

export type TerminalPaneHttpLinkDestinationResolvers = {
  getHttpLinkSourceOwnerForPane: (
    paneId: number
  ) => ReturnType<typeof resolveTerminalHttpLinkSourceOwner>
  canOpenOwnedBrowserForPane: (paneId: number) => boolean
  getHttpLinkActionDestinations: (paneId: number, url: string) => TerminalHttpLinkActionDestinations
}

/** Per-mount closures over the pane's transports; `url` is required because plugin
 *  link routes match on the clicked URL. */
export function createTerminalPaneHttpLinkDestinationResolvers(
  deps: UseTerminalPaneLifecycleDeps
): TerminalPaneHttpLinkDestinationResolvers {
  const paneTransports = deps.paneTransportsRef.current
  const getHttpLinkSourceOwnerForPane = (
    paneId: number
  ): ReturnType<typeof resolveTerminalHttpLinkSourceOwner> =>
    resolveTerminalHttpLinkSourceOwner(paneTransports.get(paneId))
  const canOpenOwnedBrowserForPane = (paneId: number): boolean => {
    const sourceOwner = getHttpLinkSourceOwnerForPane(paneId)
    if (sourceOwner.kind === 'runtime') {
      return canOpenWorkspaceBrowserTabOnRuntime(
        useAppStore.getState(),
        deps.worktreeId,
        sourceOwner.runtimeEnvironmentId
      )
    }
    return (
      sourceOwner.kind === 'ssh' &&
      canOpenWorkspaceBrowserTabOnSsh(
        useAppStore.getState(),
        deps.worktreeId,
        sourceOwner.connectionId
      )
    )
  }
  return {
    getHttpLinkSourceOwnerForPane,
    canOpenOwnedBrowserForPane,
    // Synchronous on purpose: both click handlers call preventDefault() in the same
    // tick, so this must never await an IPC fetch of the route table.
    getHttpLinkActionDestinations: (paneId, url) =>
      httpLinkActionDestinationsFor(
        deps.settingsRef.current,
        getHttpLinkSourceOwnerForPane(paneId),
        canOpenOwnedBrowserForPane(paneId),
        url
      )
  }
}
