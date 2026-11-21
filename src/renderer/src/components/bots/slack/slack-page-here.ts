// Slack's pages for a bot on any computer open in this computer's browser, for the person here.
// The config-token page has no return, and Slack's approval returns to Orca Cloud, never to the
// bot's computer, so neither needs the host's network. One Slack login then makes the token and
// approves the app. Never a server's Orca browser, which opens in one of its bots' workspaces.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openSignInPageInBrowser } from '../bot-tool-sign-in-state'
import { botSlackErrorMessage } from './bot-slack-copy'

const SLACK_APPS_URL = 'https://api.slack.com/apps'
const SLACK_ORIGIN = 'https://slack.com'
const SLACK_AUTHORIZE_PATH = /^\/oauth\/v2\/authorize(?:[?#]|$)/

/** The setup flow's code for a refused approval link; botSlackErrorMessage says it. */
export const NOT_SLACK_LINK = 'not_slack_link'

/**
 * Slack's own approval page: the only link a host's answer may open or copy here. Checked as
 * written, not only as parsed, so a link copied as-is is the one that was checked. Hosts are
 * case-insensitive; everything else must be spelled exactly.
 */
export function isSlackAuthorizeUrl(url: string): boolean {
  // ASCII-only case folding: Unicode lowercasing would let a look-alike letter spell the host.
  const origin = url.slice(0, SLACK_ORIGIN.length).replace(/[A-Z]/g, (c) => c.toLowerCase())
  if (origin !== SLACK_ORIGIN || !SLACK_AUTHORIZE_PATH.test(url.slice(SLACK_ORIGIN.length))) {
    return false
  }
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

/** True once this computer's browser took the page; says so when it didn't. */
async function openHere(url: string): Promise<boolean> {
  try {
    await openSignInPageInBrowser(url)
    return true
  } catch {
    toast.error(
      translate('bots.slack.setup.browserFailed', 'Orca couldn’t open your browser. Try again.')
    )
    return false
  }
}

/** Where Slack lists "Your App Configuration Tokens". */
export function openSlackAppsHere(): Promise<boolean> {
  return openHere(SLACK_APPS_URL)
}

/** Slack's approval page; anything else is refused with a toast (the setup flow refuses it first). */
export function openSlackApprovalHere(url: string): Promise<boolean> {
  if (!isSlackAuthorizeUrl(url)) {
    toast.error(botSlackErrorMessage(NOT_SLACK_LINK, null))
    return Promise.resolve(false)
  }
  return openHere(url)
}
