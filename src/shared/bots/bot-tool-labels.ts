import type { BotOwnTool } from '../bot-tools'

/** notion → Notion, globex-metrics → Globex metrics. */
export function botToolTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name
}

/** A row's short line: a remote server's host, or the package or program a command runs. */
export function botToolSubtitle(tool: Pick<BotOwnTool, 'detail' | 'remote'>): string {
  if (tool.remote) {
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
