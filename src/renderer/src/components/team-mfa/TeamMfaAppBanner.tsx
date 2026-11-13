import { useTeamMfaGate } from './TeamMfaGate'

/**
 * The MFA notice in the sidebar's banner stack, for the active team: a countdown while there is
 * still time, and "no access until you set it up" after the deadline. Renders nothing for a
 * personal account, a team with no policy, or a member who already has MFA, which is almost
 * everyone.
 *
 * The sidebar can be collapsed, so this is a reminder, not the enforcement surface: a refused
 * team resource shows TeamMfaRefused in its own place whether or not the sidebar is visible.
 */
export function TeamMfaSidebarBanner(): React.JSX.Element | null {
  return useTeamMfaGate().sidebarBanner
}

/**
 * In place of a team resource the server refused with `mfa_required`: the setup screen, or (when
 * the policy cannot be read to fill it in) nothing, so the caller's own error copy shows.
 */
export function TeamMfaRefused(): React.JSX.Element | null {
  return useTeamMfaGate({ forceBlocked: true }).blocked
}
