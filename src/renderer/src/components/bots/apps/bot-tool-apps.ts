// The apps a bot has as tools: the ones Add to <bot> lists (BOT_MCP_APPS) and the ones added by URL.
// The bot's Connectors list and Add to <bot> both read this, so an added app shows in both.
import type { BotOwnTool, BotToolProblem } from '../../../../../shared/bot-tools'
import { isBotAppTool, type BotToolsView } from '../bot-tool-checks'
import { DIRECT_APPS, type BotDirectApp } from './bot-app-catalog'

export type BotMcpDirectApp = Extract<BotDirectApp, { route: 'mcp' }>

/** One remote tool as an app: `app` when it is one Add to <bot> lists, else added by URL. */
export type BotToolApp = {
  tool: BotOwnTool
  app: BotMcpDirectApp | null
  /** What the host's check says is wrong, for the bot's current agent; undefined: all is well. */
  problem: BotToolProblem | undefined
}

const MCP_APPS = DIRECT_APPS.filter((app): app is BotMcpDirectApp => app.route === 'mcp')

const NO_APPS: BotToolApp[] = []

/** Command tools stay in Tools; the Composio tool is drawn as its own app rows. */
export function botToolApps(view: BotToolsView): BotToolApp[] {
  if (view.status !== 'ready' || !('own' in view.tools)) {
    return NO_APPS
  }
  return view.tools.own.filter(isBotAppTool).map((tool) => ({
    tool,
    app: MCP_APPS.find((app) => app.id === tool.name) ?? null,
    problem: view.problems[tool.name]
  }))
}

/** Signing in again or fixing a server that won't start is the owner's to do. */
export function botToolAppNeedsOwner({ tool, problem }: BotToolApp): boolean {
  if (tool.signIn) {
    return tool.signIn.state !== 'signed-in'
  }
  return problem?.kind === 'sign-in' || problem?.kind === 'failed'
}
