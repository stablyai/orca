// Whether bots are on: the user's setting, unless their Orca Cloud team blocks them. Kept apart from the bot
// catalog so workspace activation and the app rail can read it without importing the catalog (which imports them).
import type { AppState } from '@/store/types'
import {
  isOrcaCloudTeamFeatureBlocked,
  ORCA_CLOUD_TEAM_POLICY_FLAGS
} from '../../../shared/orca-profiles/orca-cloud-team-policy'

export function selectBotsEnabled(
  state: Pick<AppState, 'settings' | 'orcaProfileAuthStatus'>
): boolean {
  return (
    state.settings?.botsEnabled !== false &&
    !isOrcaCloudTeamFeatureBlocked(state.orcaProfileAuthStatus, ORCA_CLOUD_TEAM_POLICY_FLAGS.bots)
  )
}

/**
 * The Activity inbox (a rail button with its dot, the inbox list, and jumps to a workspace leaving it): only with
 * the experimental app rail on and bots on. Otherwise everything is today's, the Projects bell and Activity list.
 */
export function selectActivityInboxEnabled(
  state: Pick<AppState, 'settings' | 'orcaProfileAuthStatus'>
): boolean {
  return state.settings?.experimentalAppRail === true && selectBotsEnabled(state)
}
