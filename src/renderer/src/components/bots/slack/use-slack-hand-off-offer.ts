// Whether a paired computer's bot may take its Slack app from this desktop's own Orca account: the
// account signed in here, and the workspaces its token is offered for.
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useHostBots } from '@/lib/bot-catalog'
import { useBotHostOrcaAccount } from '@/lib/bot-host-orca-account'
import { useAppStore } from '@/store'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { BotSlackSetupStep } from './use-bot-slack-setup'
import { slackWorkspaces } from './SlackWorkspacesSettings'

export type SlackHandOffOffer = { email: string; teamIds: string[] }

/**
 * Workspaces this computer's own bots are in, so this account has a token there and the names are
 * known; the bot's own left out. A lapsed token on the host offers only its workspace.
 */
export function slackHandOffTeams(
  bot: Pick<Bot, 'slack' | 'slackApps'>,
  localBots: readonly Bot[],
  lapsedTeamId: string | undefined
): string[] {
  const own = new Set(botSlackApps(bot).map((app) => app.teamId))
  return slackWorkspaces(localBots)
    .map((workspace) => workspace.teamId)
    .filter((teamId) => !own.has(teamId) && (lapsedTeamId === undefined || teamId === lapsedTeamId))
}

/**
 * Offered only on a paired computer whose own Orca account has no token for the workspace (its
 * token form shows), signed in to an account other than this desktop's, while this desktop is
 * signed in. Null otherwise: today's dialog, unchanged.
 */
export function useSlackHandOffOffer(bot: Bot, step: BotSlackSetupStep): SlackHandOffOffer | null {
  const paired = bot.hostId !== LOCAL_EXECUTION_HOST_ID
  const localBots = useHostBots(LOCAL_EXECUTION_HOST_ID)
  const hostAccount = useBotHostOrcaAccount(bot.hostId)
  const own = useAppStore((state) =>
    state.orcaProfileAuthStatus?.state === 'connected'
      ? (state.orcaProfileAuthStatus.cloud?.email ?? null)
      : null
  )
  // Only Orca's own desktop window spends this account's token; a paired web client has no redeem.
  if (!paired || isPairedWebClientWindow() || step.kind !== 'token' || step.mine || !own) {
    return null
  }
  if (hostAccount?.state !== 'signed-in' || !hostAccount.email || hostAccount.email === own) {
    return null
  }
  const teamIds = slackHandOffTeams(bot, localBots, step.reconnect ? step.teamId : undefined)
  return teamIds.length > 0 ? { email: own, teamIds } : null
}
