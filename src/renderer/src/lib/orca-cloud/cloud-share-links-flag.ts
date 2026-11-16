// SHARE-LINKS-HOLD (Neil): cloud workspace share links are held for this release. The code stays;
// every way to produce a link (Copy › Workspace link / chat link, the cloud list's Copy link items,
// ⌘⌥⇧L and its Settings entry) is off unless the account's capabilities turn on `cloudShareLinks`.
// Opening an orca://cloud link someone already has still works. Share with team (visibility) stays.
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'

export const CLOUD_SHARE_LINKS_FLAG = 'cloudShareLinks'
export const CLOUD_SHARE_LINK_ACTION_ID = 'cloudWorkspace.copyLink'

function enabledFor(status: OrcaProfileAuthStatus | null | undefined): boolean {
  return status?.capabilities?.flags[CLOUD_SHARE_LINKS_FLAG] === true
}

/** Outside React (keyboard handlers, the copy itself, Settings' shortcut list). */
export function cloudShareLinksEnabled(): boolean {
  return enabledFor(useAppStore.getState().orcaProfileAuthStatus)
}

export function useCloudShareLinksEnabled(): boolean {
  return useAppStore((state) => enabledFor(state.orcaProfileAuthStatus))
}
