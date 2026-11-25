// `orca bot connectors --offer teams`: Teams has no Connect card yet. Its sign-in runs in a terminal
// on the bot's computer, so the owner sees one line in the bot's chat with the commands to run.
import type { TeamsAccountView } from './teams-connect-types'

export const TEAMS_OFFER_SOURCE = 'teams'

export type TeamsBotState = { account: Pick<TeamsAccountView, 'status'> | null; botOn: boolean }

/** The line the owner sees, or null when nothing is missing. */
export function teamsOfferLine(state: TeamsBotState, botName: string): string | null {
  const turnOn = `\`orca teams bot "${botName}" --on\``
  if (!state.account) {
    return `${botName} asks to use Microsoft Teams as you. On the computer it runs on, run \`orca teams connect --tenant <tenant> --client <app id>\` (\`orca teams connect --help\` covers the Entra app it needs), then ${turnOn}. Then tell ${botName}.`
  }
  if (state.account.status !== 'connected') {
    return `${botName} asks to use Microsoft Teams, and the Teams sign-in on its computer has ended. Run \`orca teams connect\` there again${state.botOn ? '' : `, then ${turnOn}`}. Then tell ${botName}.`
  }
  return state.botOn
    ? null
    : `${botName} asks to use Microsoft Teams as you. On the computer it runs on, run ${turnOn}. Then tell ${botName}.`
}

export function teamsOfferReply(
  state: TeamsBotState,
  botName: string
): { offered: boolean; message: string } {
  return teamsOfferLine(state, botName)
    ? {
        offered: true,
        message:
          "Your owner now sees a line in this chat with the commands that connect Teams for you. Don't repeat them. Before using it, check with `orca bot connectors`."
      }
    : {
        offered: false,
        message: 'Microsoft Teams is already connected and on for you; no line was shown.'
      }
}
