import { useBotHostHas } from '@/lib/bot-host-status'
import {
  BOTS_CONNECTORS_RUNTIME_CAPABILITY,
  BOTS_FEISHU_LOCAL_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { ComponentType } from 'react'
import { useFeishuState } from './feishu/feishu-local-client'
import { Send, Webhook } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useBotGitHub } from '@/lib/bot-github-state'
import { useBotLinear } from '@/lib/bot-linear-state'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../../../shared/bot-types'
import { DiscordIcon } from '../icons/DiscordIcon'
import { GitHubIcon } from '../icons/GitHubIcon'
import { GoogleIcon } from '../icons/GoogleIcon'
import { LinearIcon } from '../icons/LinearIcon'
import { SlackIcon } from '../icons/SlackIcon'
import { useWebhooksConnector } from './webhooks/use-webhooks-connector'

export type BotConnector = {
  id: 'feishu-local' | 'slack' | 'discord' | 'google' | 'linear' | 'github' | 'webhooks'
  label: string
  Icon: ComponentType<{ className?: string }>
  /** False shows the connector as "Coming soon"; see useBotConnectorAvailable for Linear and GitHub. */
  available: boolean
  /** link: an account the connector list links. chat: set up by asking the bot in its Chat. */
  add: 'link' | 'chat'
}

/** Where people can reach a bot, in the order every connector list shows them. */
export const BOT_CONNECTORS: readonly BotConnector[] = [
  { id: 'slack', label: 'Slack', Icon: SlackIcon, available: true, add: 'link' },
  {
    id: 'feishu-local',
    get label() {
      return translate('bots.feishu.name', 'Feishu')
    },
    Icon: Send,
    available: true,
    add: 'link'
  },
  { id: 'discord', label: 'Discord', Icon: DiscordIcon, available: false, add: 'link' },
  { id: 'google', label: 'Google', Icon: GoogleIcon, available: true, add: 'link' },
  { id: 'linear', label: 'Linear', Icon: LinearIcon, available: true, add: 'link' },
  { id: 'github', label: 'GitHub', Icon: GitHubIcon, available: true, add: 'link' },
  {
    id: 'webhooks',
    get label() {
      return translate('bots.webhooks.name', 'Webhooks')
    },
    Icon: Webhook,
    available: true,
    add: 'chat'
  }
]

/** The connectors that link an account, for lists of linked accounts across bots. */
export const ACCOUNT_CONNECTORS = BOT_CONNECTORS.filter((connector) => connector.add === 'link')

/** Whether an account connector can be added now on the host: Linear and GitHub also wait for its cloud. */
export function useBotConnectorAvailable(
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): (connector: BotConnector) => boolean {
  const linear = useBotLinear(hostId)
  const github = useBotGitHub(hostId)
  const cloudOn = { linear: cloudHasIt(linear.status), github: cloudHasIt(github.status) }
  return (connector) =>
    connector.available &&
    connector.add === 'link' &&
    (connector.id === 'linear' || connector.id === 'github' ? cloudOn[connector.id] : true)
}

/** The same test the bot's Connectors settings use, for connectors a bot's own record shows. */
export function connectorAdded(bot: Bot, id: BotConnector['id']): boolean {
  return (
    (id === 'slack' && botSlackApps(bot).length > 0) ||
    (id === 'linear' && botLinearWorkspaces(bot).length > 0) ||
    (id === 'github' && bot.github !== null) ||
    (id === 'google' && bot.google === true)
  )
}

/**
 * One bot's connectors: which can be added and which it has. Webhooks count once the bot's host
 * answers with its hooks; until then, or with webhooks off, they're not offered.
 */
export function useBotConnectorState(bot: Bot): {
  /** The registry, less webhooks while they aren't offered. */
  catalog: readonly BotConnector[]
  available: (connector: BotConnector) => boolean
  added: (connector: BotConnector) => boolean
} {
  const accountAvailable = useBotConnectorAvailable(bot.hostId)
  const webhooks = useWebhooksConnector(bot)
  // Slack, Linear and GitHub set up on the bot's host; an older one can't from here.
  const feishu = useFeishuState(bot)
  const hasFeishu = useBotHostHas(bot.hostId, BOTS_FEISHU_LOCAL_CAPABILITY)
  const setUpHere = useBotHostHas(bot.hostId, BOTS_CONNECTORS_RUNTIME_CAPABILITY)
  return {
    catalog: BOT_CONNECTORS.filter(
      (connector) =>
        (connector.id !== 'webhooks' || webhooks !== null) &&
        (connector.id !== 'feishu-local' || hasFeishu)
    ),
    available: (connector) =>
      connector.id === 'webhooks'
        ? webhooks !== null
        : accountAvailable(connector) && (setUpHere || connector.id === 'google'),
    added: (connector) =>
      connector.id === 'feishu-local'
        ? !!feishu && feishu.status !== 'off'
        : connector.id === 'webhooks'
          ? webhooks === 'added'
          : connectorAdded(bot, connector.id)
  }
}

function cloudHasIt(status: 'loading' | 'off' | 'ready' | 'failed'): boolean {
  return status === 'ready' || status === 'failed'
}

/** The action that adds access to a connected account connector, on its chat card and its row: GitHub's
 *  install page adds repositories or organizations, Slack and Linear another workspace. */
export function connectorAddAccessLabel(id: 'slack' | 'linear' | 'github'): string {
  return id === 'github'
    ? translate('bots.connectors.addGitHubAccess', 'Add repositories or organizations')
    : translate('bots.connectors.addAnotherWorkspace', 'Add another workspace')
}
