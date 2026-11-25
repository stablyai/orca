// Slack's page already open (or its link copied) for this bot and workspace in this open of the
// dialog: the flow mounts anew when it comes back from the pill, and must not open Slack again.
import type { Bot } from '../../../../../shared/bot-types'
import type { SlackInstallLink } from './slack-install-link'

export type OpenedSlackPage = { returnUrl: string | null; link: SlackInstallLink }

export const openedSlackPages = new Map<string, OpenedSlackPage>()

export const openedKey = (bot: Pick<Bot, 'hostId' | 'id'>, teamId: string): string =>
  `${bot.hostId}\0${bot.id}\0${teamId}`

/** A new open of the dialog is a fresh attempt, which opens Slack's page again. */
export function forgetOpenedSlackPages(bot: Pick<Bot, 'hostId' | 'id'>): void {
  for (const key of openedSlackPages.keys()) {
    if (key.startsWith(`${bot.hostId}\0${bot.id}\0`)) {
      openedSlackPages.delete(key)
    }
  }
}
