// What a connect trip (Connect Linear, Connect GitHub, Sign in with Slack) says when it ends, and
// where its account shows afterwards, per source: every surface that runs or finishes one reads it here.
import { translate } from '@/i18n/i18n'
import { BOT_SLACK_SIGN_IN_OFF } from '../../../../shared/connector-bot-slack-contract'
import type { ConnectorConnectSource } from '../../../../shared/connectors/connector-cloud-contract'
import { botGitHubErrorMessage } from './github/bot-github-copy'
import { botLinearErrorMessage } from './linear/bot-linear-copy'
import { botSlackErrorMessage } from './slack/bot-slack-copy'

/** Sign in with Slack's own trip codes; the rest are Slack setup's. */
function slackTripErrorMessage(code: string, hostName: string | null): string {
  switch (code) {
    case BOT_SLACK_SIGN_IN_OFF:
      return translate('settings.linkedAccounts.slackOff', 'Linking Slack isn’t available yet.')
    case 'expired':
      return translate(
        'bots.slack.errors.tripExpired',
        'Slack didn’t finish. A newer sign-in may have replaced it. Start again.'
      )
    case 'wrong_account':
      return translate(
        'bots.slack.errors.wrongAccount',
        'This sign-in was started from another Orca account. Sign in with Slack again from this one.'
      )
    default:
      return botSlackErrorMessage(code, hostName)
  }
}

const TRIP_ERRORS: Record<
  ConnectorConnectSource,
  (code: string, hostName: string | null) => string
> = { linear: botLinearErrorMessage, github: botGitHubErrorMessage, slack: slackTripErrorMessage }

export function connectorTripErrorMessage(
  source: ConnectorConnectSource,
  code: string,
  hostName: string | null
): string {
  return TRIP_ERRORS[source](code, hostName)
}

export function connectorConnectedMessage(source: ConnectorConnectSource): string {
  switch (source) {
    case 'linear':
      return translate('bots.linear.connect.connected', 'Linear connected.')
    case 'github':
      return translate('bots.github.connect.connected', 'GitHub connected.')
    case 'slack':
      return translate('bots.slack.connect.linked', 'Slack linked.')
  }
}

/** Linear and GitHub show under Settings › Bots; a Slack sign-in is a linked account. */
export const CONNECTOR_SETTINGS_PANE = {
  linear: 'bots',
  github: 'bots',
  slack: 'orca-account'
} as const satisfies Record<ConnectorConnectSource, string>
