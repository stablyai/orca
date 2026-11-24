import type { HttpLinkDestination } from '@/lib/browser/navigation/http-link-routing'
import { awaitGitHubChange, type AwaitGitHubOptions, type GitHubWait } from '@/lib/bot-github-state'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { BotRef } from '@/lib/bot-hosts'

/** GitHub's App install page, from every surface: this computer's per Orca's link setting, a
 *  server's in its own page in Orca's browser; then followed until the host's installs change.
 *  Returns where it opened, so a dialog in the way can minimize, and the wait; null when a server's
 *  page couldn't open in its own session, which was said. */
export function openGitHubInstallPage(
  bot: BotRef,
  url: string,
  waitMs?: number,
  options?: AwaitGitHubOptions
): { destination: HttpLinkDestination; wait: GitHubWait } | null {
  const destination = openBotHostPageOrSay(bot.hostId, url, { bot, local: 'link-setting' })
  if (destination === 'unrouted') {
    return null
  }
  const wait = awaitGitHubChange(bot.hostId, waitMs, options)
  return { destination, wait }
}
