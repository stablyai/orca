import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { clearWebSessionCloseIntent } from './web-session-close-intent'
import type { WebSessionIntentOwner } from '../identity/web-session-intent-owner'
import { refreshWebRuntimeSessionTabsSnapshot } from '../inventory/web-runtime-session-snapshot'
import { isServerFrameDrawnWorkspace } from '../frame-drawn/frame-drawn-server-workspace-set'
import { redrawServerLayoutWorkspace } from '../../workspace-layout/server/server-layout-apply-routes'

/** An older host would stop terminals that joined after the user approved, so the close is not sent. */
export async function keepTabOpenForUnhonoredApproval(
  intentOwner: WebSessionIntentOwner,
  worktreeId: string,
  closeIntentTabIds: ReadonlySet<string>
): Promise<void> {
  const { environmentId } = intentOwner
  for (const hostTabId of closeIntentTabIds) {
    clearWebSessionCloseIntent(intentOwner, worktreeId, hostTabId)
  }
  try {
    const { acceptReplayedWebSessionTabsSnapshot } = await import('../state')
    acceptReplayedWebSessionTabsSnapshot(environmentId, worktreeId)
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision
    })
    if (isServerFrameDrawnWorkspace(environmentId, worktreeId)) {
      redrawServerLayoutWorkspace(environmentId, worktreeId)
    }
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to restore tab after unhonored close approval:',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    toast.error(
      translate(
        'runtime.sessionTabs.closeNeedsHostUpdate',
        'Update the paired host to close this terminal tab. It was kept open.'
      )
    )
  }
}
