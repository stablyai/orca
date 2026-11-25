import { getWorkspaceClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import {
  openOwnedHttpLink,
  type HttpLinkSourceOwner
} from '@/lib/browser/navigation/http-link-routing'
import { canOpenRemoteLinkInWorkspaceBrowser } from '@/lib/browser/workspace/workspace-browser-route-eligibility'
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
    destination?: 'orca' | 'system'
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
  // When destination is not specified, respect the user's link routing setting.
  // The default behavior of openOwnedHttpLink will use the managed browser if
  // available, otherwise fall back to system browser.
  if (!destination) {
    openOwnedHttpLink(url, {
      allowRemoteInApp: true,
      worktreeId,
      sourceOwner
    })
    return
  }
  const canOpenOwnedBrowser =
    sourceOwner.kind === 'local'
      ? getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'].state ===
        'enabled'
      : canOpenRemoteLinkInWorkspaceBrowser(state, worktreeId, sourceOwner)
  if (!canOpenOwnedBrowser) {
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
