// Which saved bots an older Orca still reads, so a rollback after this build keeps them.
import type { Bot } from '../bot-types'

/** Agents the previous release's bot schema reads; it drops bots on any other agent when it loads. */
const BOT_AGENTS_OLDER_BUILDS_READ: ReadonlySet<string> = new Set([
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity'
])

/** Bots saved where an older build, after a rollback, cannot drop them: it ignores keys it does not know. */
export function splitBotsByOlderBuildSupport(bots: readonly Bot[]): {
  readable: Bot[]
  newer: Bot[]
} {
  const readable: Bot[] = []
  const newer: Bot[] = []
  for (const bot of bots) {
    const side = BOT_AGENTS_OLDER_BUILDS_READ.has(bot.agent) ? readable : newer
    side.push(bot)
  }
  return { readable, newer }
}
