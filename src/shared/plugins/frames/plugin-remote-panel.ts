/** main → renderer: a panel's paired host went away; the panel re-reads its entry. */
export const PLUGIN_REMOTE_PANEL_CLOSED_CHANNEL = 'plugins:remotePanelClosed'

/**
 * Whether a panel's calls and pushes now go to the paired host behind the focused workspace.
 * `bindingId` names this binding, so a late unbind cannot release a newer one for the same token.
 */
export type PluginRemotePanelBinding =
  | { bound: true; hostName: string; bindingId: number }
  | { bound: false; reason: string }
