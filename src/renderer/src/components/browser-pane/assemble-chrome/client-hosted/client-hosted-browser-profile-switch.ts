import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserTabSetProfileResult } from '../../../../../../shared/browser/runtime/runtime-browser-contracts'

/**
 * The server owns the page and runs the guest swap, so the switch goes to it; its next page snapshot
 * moves this desktop's guest. A timeout leaves the guest alone, since a late success still lands.
 */
export function switchClientHostedBrowserPageProfile(
  environmentId: string,
  browserPageId: string,
  profileId: string
): Promise<BrowserTabSetProfileResult> {
  return callRuntimeRpc<BrowserTabSetProfileResult>(
    { kind: 'environment', environmentId },
    'browser.tabSetProfile',
    { page: browserPageId, profileId },
    // Outlasts the server's 30 s guest swap, so its own answer arrives first; a user action, not agent use.
    { timeoutMs: 45_000, suppressFeatureInteraction: true }
  )
}
