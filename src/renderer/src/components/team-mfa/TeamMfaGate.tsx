import { useState } from 'react'
import { useAppStore } from '@/store'
import { TeamMfaBanner } from './TeamMfaBanner'
import { TeamMfaBlockedScreen } from './TeamMfaBlockedScreen'
import { teamMfaSurface } from './team-mfa-copy'
import { useTeamMfaPolicy } from './use-team-mfa-policy'

/**
 * The active team's MFA requirement, for a surface that shows the team's cloud content.
 *
 * - `banner`: render above the content while the member still has time.
 * - `blocked`: render in place of the content once the server refused the team's resources.
 *   `forceBlocked` is that refusal (`mfa_required`); the policy read alone also blocks when the
 *   server says so, so the screen shows without waiting for a failed request.
 *
 * Renders nothing for a personal account, a team with no policy, a member who has MFA, or a
 * server without the policy API.
 */
export function useTeamMfaGate(options: { forceBlocked?: boolean } = {}): {
  banner: React.JSX.Element | null
  blocked: React.JSX.Element | null
} {
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const selectOrg = useAppStore((state) => state.selectOrcaProfileOrg)
  const orgId = cloud?.activeOrgId ?? null
  const teamName = cloud?.activeOrgName ?? ''
  const { policy, checking, refresh } = useTeamMfaPolicy(orgId)
  const [now] = useState(() => Date.now())
  const [stillMissing, setStillMissing] = useState(false)

  if (!orgId || !policy?.policy) {
    return { banner: null, blocked: null }
  }
  const surface = teamMfaSurface(policy)
  const openSetup = (): void => {
    void window.api.shell.openUrl(policy.setupUrl)
  }

  // The server's refusal wins over a policy read that has not caught up, unless that read now
  // says the member has MFA (they just set it up; the next request will go through).
  const isBlocked = surface === 'blocked' || (options.forceBlocked === true && policy.self !== 'on')
  if (isBlocked) {
    return {
      banner: null,
      blocked: (
        <TeamMfaBlockedScreen
          teamName={teamName}
          enforceAt={policy.policy.enforceAt}
          setupUrl={policy.setupUrl}
          checking={checking}
          stillMissing={stillMissing}
          onSetUp={openSetup}
          onRecheck={() => {
            void refresh().then((next) => {
              // Null: the read failed; say nothing rather than claim MFA is still missing.
              setStillMissing(next !== null && next.self !== 'on')
            })
          }}
          onUsePersonal={() => void selectOrg(null)}
        />
      )
    }
  }
  return {
    banner:
      surface === 'banner' ? (
        <TeamMfaBanner
          teamName={teamName}
          enforceAt={policy.policy.enforceAt}
          now={now}
          setupUrl={policy.setupUrl}
          onSetUp={openSetup}
        />
      ) : null,
    blocked: null
  }
}
