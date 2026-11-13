import { canSourceOwnerOpenInOrca } from '@/lib/browser/navigation/http-link-destinations'
import {
  openOwnedHttpLink,
  type HttpLinkSourceOwner
} from '@/lib/browser/navigation/http-link-routing'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/browser/workspace/workspace-browser-route-eligibility'
import type { AppState } from '@/store/types'

export function openMarkdownExternalUrl(
  url: string,
  {
    state,
    worktreeId,
    sourceOwner,
    destination
  }: {
    state: AppState
    worktreeId: string | null
    sourceOwner: HttpLinkSourceOwner
    destination: 'orca' | 'system'
  }
): void {
  if (sourceOwner.kind === 'unknown') {
    return
  }
  if (destination === 'system' || !worktreeId) {
    openOwnedHttpLink(url, {
      worktreeId,
      sourceOwner,
      forceSystemBrowser: true
    })
    return
  }
  const canOpenOwnedBrowser =
    sourceOwner.kind === 'runtime'
      ? canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId)
      : sourceOwner.kind === 'ssh' &&
        canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId)
  if (!canSourceOwnerOpenInOrca(sourceOwner, canOpenOwnedBrowser)) {
    openOwnedHttpLink(url, {
      worktreeId,
      sourceOwner,
      forceSystemBrowser: true
    })
    return
  }
  openOwnedHttpLink(url, {
    allowRemoteInApp: true,
    worktreeId,
    sourceOwner,
    forceInApp: true
  })
}
