// Slack's install link for one setup attempt, and when it stops working.
import { useEffect, useState } from 'react'
import type { ConnectorBotSlackAppResponse } from '../../../../../shared/connector-bot-slack-contract'

/** `expiresAt` (ms) from a cloud that says when the link stops working; null from an older one. */
export type SlackInstallLink = { authorizeUrl: string; expiresAt: number | null }

export const slackInstallLink = (app: ConnectorBotSlackAppResponse): SlackInstallLink => ({
  authorizeUrl: app.authorizeUrl,
  expiresAt: app.expiresAt ?? null
})

/** Whether `expiresAt` has passed, flipping when it does. */
export function useSlackLinkExpired(expiresAt: number | null): boolean {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expiresAt === null) {
      return
    }
    const left = expiresAt - Date.now()
    if (left <= 0) {
      setNow(Date.now())
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), left)
    return () => clearTimeout(timer)
  }, [expiresAt])
  return expiresAt !== null && now >= expiresAt
}

/** The install link's OAuth state, which the install it completes keeps for its after-install pick. */
export function slackInstallState(authorizeUrl: string): string | null {
  try {
    return new URL(authorizeUrl).searchParams.get('state')
  } catch {
    return null
  }
}

/** Slack's own link to an app's direct messages in its workspace: it opens the Slack app there. */
export function slackAppMessagesUrl(appId: string, teamId: string): string {
  return `https://slack.com/app_redirect?${new URLSearchParams({ app: appId, team: teamId }).toString()}`
}
