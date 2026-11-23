import type { BotOwnTool } from '../bot-tools'

/** notion → Notion, globex-metrics → Globex metrics. */
export function botToolTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name
}

/** A row's short line: a remote server's host, or the package or program a command runs. */
export function botToolSubtitle(tool: Pick<BotOwnTool, 'detail' | 'remote'>): string {
  // A URL tool with saved values or Orca's own sign-in isn't `remote`, but still has an address.
  if (tool.remote || /^https?:\/\//i.test(tool.detail)) {
    try {
      return new URL(tool.detail).host
    } catch {
      return tool.detail
    }
  }
  const [program = '', ...args] = tool.detail.split(/\s+/)
  const runs = args.find((arg) => !arg.startsWith('-')) ?? program
  const base = runs.split(/[\\/]/).filter(Boolean)
  // A script names its folder: node ~/tools/metrics-mcp/index.js → metrics-mcp.
  const last = base.at(-1) ?? runs
  return /^index\.[cm]?[jt]s$/.test(last) && base.length > 1
    ? base.at(-2)!
    : last.replace(/@[^@/]*$/, '')
}

/** The platform's words for botToolsLine. */
export type BotToolsLineWords = {
  none: string
  /** "{{count}} from {{agent}}": the bot has only its owner's own tools. */
  from: (count: number) => string
  /** "{{count}} more from {{agent}}", after the bot's own tools. */
  more: (count: number) => string
  list: (names: readonly string[]) => string
}

/** "Sentry, Playwright · 6 more from Claude Code"; null until the tools are read. */
export function botToolsLine(
  tools: { own: readonly Pick<BotOwnTool, 'name'>[]; inherited: readonly unknown[] } | null,
  words: BotToolsLineWords
): string | null {
  if (!tools) {
    return null
  }
  const own = tools.own.map((tool) => botToolTitle(tool.name))
  const inherited = tools.inherited.length
  if (own.length === 0) {
    return inherited > 0 ? words.from(inherited) : words.none
  }
  const names = words.list(own)
  return inherited > 0 ? `${names} · ${words.more(inherited)}` : names
}
