import { getWorkspaceClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import {
  openOwnedHttpLink,
  type HttpLinkSourceOwner
} from '@/lib/browser/navigation/http-link-routing'
import { canOpenRemoteLinkInWorkspaceBrowser } from '@/lib/browser/workspace/workspace-browser-route-eligibility'
import { resolveModifierRouting } from '@/lib/browser/navigation/http-link-modifier-routing'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
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

/**
 * Markdown surfaces follow the same Link routing the terminal uses: the setting picks the default
 * destination and Shift inverts it for one click when that option is on (#44311).
 */
export function resolveMarkdownHttpLinkDestination(
  settings:
    | Pick<GlobalSettings, 'openLinksInApp' | 'openLinksInAppModifierInverts'>
    | null
    | undefined,
  shiftKey: boolean
): 'orca' | 'system' {
  const openInApp = settings?.openLinksInApp === true
  const modifier = resolveModifierRouting(
    shiftKey,
    openInApp,
    settings?.openLinksInAppModifierInverts === true
  )
  if (modifier.wantsSystemBrowser) {
    return 'system'
  }
  if (modifier.wantsOrca) {
    return 'orca'
  }
  return openInApp ? 'orca' : 'system'
}
