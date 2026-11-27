// The apps a bot has as tools: the ones Add to <bot> lists (BOT_MCP_APPS) and the ones added by URL.
// The bot's Connectors list and Add to <bot> both read this, so an added app shows in both.
import { botToolAppsOf, type BotToolApp } from '../../../../../shared/bots/bot-connector-entries'
import type { BotToolsView } from '../bot-tool-checks'

export type { BotToolApp }

const NO_APPS: BotToolApp[] = []

export function botToolApps(view: BotToolsView): BotToolApp[] {
  if (view.status !== 'ready' || !('own' in view.tools)) {
    return NO_APPS
  }
  return botToolAppsOf(view.tools.own, view.problems)
}
