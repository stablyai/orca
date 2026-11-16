// TEAM-SHARING-HOLD (Neil): sharing cloud workspaces with the team is held for a future release. The
// code stays; the desktop offers none of it unless the account's capabilities turn on
// `cloudTeamSharing` (absent = off, so an older or unaware control plane never brings it back):
// - Share with team / Make private (sidebar, the cloud list, the workspace panel);
// - the private/shared badges and Settings' visibility labels;
// - the "Team" scope of Open cloud workspace…, and the people chip on a workspace;
// - share links (Copy › Workspace link / chat link, the list's Copy link items, ⌘⌥⇧L and its
//   Settings entry), since a link only helps someone else open a shared workspace.
// Opening an orca://cloud link still works; one to a workspace you can't open shows the usual
// no-access message.
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'

export const CLOUD_TEAM_SHARING_FLAG = 'cloudTeamSharing'
export const CLOUD_SHARE_LINK_ACTION_ID = 'cloudWorkspace.copyLink'

function enabledFor(status: OrcaProfileAuthStatus | null | undefined): boolean {
  return status?.capabilities?.flags[CLOUD_TEAM_SHARING_FLAG] === true
}

/** Outside React (keyboard handlers, the copy itself, action groups, Settings' shortcut list). */
export function cloudTeamSharingEnabled(): boolean {
  return enabledFor(useAppStore.getState().orcaProfileAuthStatus)
}

export function useCloudTeamSharingEnabled(): boolean {
  return useAppStore((state) => enabledFor(state.orcaProfileAuthStatus))
}
