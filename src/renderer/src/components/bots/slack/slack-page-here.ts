// Slack's pages for a bot on any computer open in this computer's browser, for the person here.
// The config-token page has no return, and Slack's approval returns to Orca Cloud, never to the
// bot's computer, so neither needs the host's network. One Slack login then makes the token and
// approves the app. No bot is passed: a server's page would open in one of its bots' workspaces.
import { toast } from 'sonner'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { HttpLinkDestination } from '@/lib/browser/navigation/http-link-routing'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { botSlackErrorMessage } from './bot-slack-copy'

const SLACK_APPS_URL = 'https://api.slack.com/apps'

/** The setup flow's code for a refused approval link; botSlackErrorMessage says it. */
export const NOT_SLACK_LINK = 'not_slack_link'

/** Slack's own approval page: the only link a host's answer may open in this computer's browser. */
export function isSlackAuthorizeUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'slack.com' &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/oauth/v2/authorize'
  )
}

/** Where Slack lists "Your App Configuration Tokens". */
export function openSlackAppsHere(): HttpLinkDestination | 'unrouted' {
  return openBotHostPageOrSay(LOCAL_EXECUTION_HOST_ID, SLACK_APPS_URL, { local: 'system' })
}

/** Slack's approval page; anything else is refused with a toast (the setup flow refuses it first). */
export function openSlackApprovalHere(url: string): HttpLinkDestination | 'unrouted' {
  if (!isSlackAuthorizeUrl(url)) {
    toast.error(botSlackErrorMessage(NOT_SLACK_LINK, null))
    return 'unrouted'
  }
  return openBotHostPageOrSay(LOCAL_EXECUTION_HOST_ID, url, { local: 'system' })
}
