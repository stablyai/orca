// The desktop's reads of a bot's connectors, as the shared list (src/shared/bots/bot-connector-entries). Settings
// and the bot page's Connectors tab list these rows; Needs you and the tab count the ones that need the owner.
import { useMemo } from 'react'
import { botTarget, ownBotHost } from '@/lib/bot-hosts'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBotGitHub } from '@/lib/bot-github-state'
import { useBotLinear } from '@/lib/bot-linear-state'
import { useBotSlack } from '@/lib/bot-slack-state'
import type { Bot } from '../../../../shared/bot-types'
import {
  botConnectorEntries as sharedBotConnectorEntries,
  type BotConnectorEntry
} from '../../../../shared/bots/bot-connector-entries'
import type { BotGitHubView } from '@/lib/bot-github-state'
import type { BotLinearView } from '@/lib/bot-linear-state'
import type { BotSlackView } from '@/lib/bot-slack-state'
import type { GoogleHostView } from './google/google-connect-client'
import type { ComposioBotView } from './composio/composio-client'
import { useComposioBot } from './composio/composio-client'
import { useBotTools, type BotToolsCheck, type BotToolsView } from './bot-tool-checks'
import { gitHubCardFace } from './github/BotGitHubCard'
import { useGoogleHost } from './google/google-connect-client'
import { linearCardFace } from './linear/BotLinearCard'
import { slackCardFace } from './slack/BotSlackCard'
import { botConnectorTitleSeparator } from './bot-connector-titles'
import { translate } from '@/i18n/i18n'

export type {
  BotConnectorEntry,
  ComposioProblem
} from '../../../../shared/bots/bot-connector-entries'

/** What the list is built from: the stores each connector's row reads. */
export type BotConnectorSources = {
  slack: BotSlackView
  linear: BotLinearView
  github: BotGitHubView
  google: GoogleHostView
  composio: ComposioBotView
  tools: BotToolsView
}

type BotConnectorInventory = {
  entries: BotConnectorEntry[]
  /** Absent rows from these services may still be configured on the host. */
  unresolved: string[]
}

const EMPTY_INVENTORY: BotConnectorInventory = { entries: [], unresolved: [] }

/**
 * The bot's connector rows in list order; null (no bot shown) reads nothing. Only a shown list
 * checks its apps' sign-ins (`apps`); counts and badges take a check it already ran (`finished`).
 */
export function useBotConnectorEntries(
  bot: Bot | null,
  appsCheck: Extract<BotToolsCheck, 'apps' | 'finished'> = 'finished'
): BotConnectorEntry[] {
  return useBotConnectorInventory(bot, appsCheck).entries
}

export function useBotConnectorInventory(
  bot: Bot | null,
  appsCheck: Extract<BotToolsCheck, 'apps' | 'finished'>
): BotConnectorInventory {
  const shown = bot !== null
  const slack = useBotSlack(bot)
  const hostId = bot?.hostId ?? ownBotHost().hostId
  const linear = useBotLinear(hostId, shown)
  const github = useBotGitHub(hostId, shown)
  // No bot shown reads nothing, so the host it would read is only a placeholder.
  const google = useGoogleHost(bot ? botTarget(bot) : ownBotHost().target, shown)
  const composio = useComposioBot(bot)
  const { view: tools } = useBotTools(bot, appsCheck)
  // Changes with the UI language, so the translated titles follow a switch.
  const t = useTranslate()
  // The panel header, tab and toggle all read it, so one list per change of its sources.
  return useMemo(() => {
    if (!bot) {
      return EMPTY_INVENTORY
    }
    const unresolved: string[] = []
    if (bot.google && google.status !== 'ready') {
      unresolved.push('google')
    }
    if (bot.github && github.status !== 'ready') {
      unresolved.push('github')
    }
    if (!composio.status || (composio.status.key !== 'none' && !composio.connections)) {
      unresolved.push('composio')
    }
    if (tools.status !== 'ready') {
      unresolved.push('app')
    }
    return {
      entries: botConnectorEntries(bot, { slack, linear, github, google, composio, tools }, t),
      unresolved
    }
  }, [bot, slack, linear, github, google, composio, tools, t])
}

/** The list itself, from the bot and its sources. */
export function botConnectorEntries(
  bot: Bot,
  { slack, linear, github, google, composio, tools }: BotConnectorSources,
  t: Translate = translate
): BotConnectorEntry[] {
  return sharedBotConnectorEntries(bot, {
    slack: (teamId) => {
      const face = slackCardFace(slack, teamId, null)
      return {
        workspace: face.workspace,
        // Can't check (signed in elsewhere aside) is not the owner's to fix.
        needsOwner: face.next !== null && face.next !== 'retry',
        updateNeeded: face.next === 'update'
      }
    },
    linearNeedsOwner: (workspace) =>
      linearCardFace(workspace, linear, null).status?.tone === 'attention',
    github: {
      installations:
        github.status === 'ready' && github.github.account ? github.github.installations : [],
      needsOwner: gitHubCardFace(github, null).status?.tone === 'attention'
    },
    google:
      google.status === 'ready'
        ? { emails: google.google.accounts.map((account) => account.email) }
        : null,
    composio: {
      key: composio.status?.key,
      added: composio.status?.added === true,
      unread: Boolean(composio.error),
      connections: composio.connections?.connections ?? []
    },
    tools:
      tools.status === 'ready' && 'own' in tools.tools
        ? { own: tools.tools.own, problems: tools.problems }
        : null,
    words: {
      webhooks: t('bots.webhooks.name', 'Webhooks'),
      viaComposio: t('bots.composio.viaComposio', 'via Composio'),
      composioApps: t('bots.composio.toolName', 'Composio apps'),
      titleSeparator: botConnectorTitleSeparator()
    }
  })
}
