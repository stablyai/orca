import { useTeamMfaGate } from './TeamMfaGate'

/**
 * The app-level MFA notice for the active team: a countdown while there is still time, and "no
 * access until you set it up" after the deadline. Renders nothing for a personal account, a team
 * with no policy, or a member who already has MFA, which is almost everyone.
 */
export function TeamMfaAppBanner({ className }: { className?: string }): React.JSX.Element | null {
  const { appBanner } = useTeamMfaGate()
  return appBanner ? <div className={className}>{appBanner}</div> : null
}

/**
 * In place of a team resource the server refused with `mfa_required`: the setup screen, or (when
 * the policy cannot be read to fill it in) nothing, so the caller's own error copy shows.
 */
export function TeamMfaRefused(): React.JSX.Element | null {
  return useTeamMfaGate({ forceBlocked: true }).blocked
}
