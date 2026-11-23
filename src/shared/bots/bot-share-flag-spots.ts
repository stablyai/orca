// Where each safety-check flag of a shared bot is: the page part that shows it, and its home file.
import type { BotShareFlag } from './bot-package'

/** A flag placed: the share page part that shows it, the file on that page, and where it lives in
 *  the bot home (null for text kept in bot.json, which has no file to open). */
export type BotShareFlagSpot = {
  flag: BotShareFlag
  /** A `bots.share.view` part, or null for no page. */
  part: string | null
  where: string
  file: string
  homePath: string | null
}

type Named = readonly { name: string }[]

/** What placing a flag reads of a candidate. */
export type BotShareFlagSource = {
  automationIds: { schedules: readonly string[]; eventSuggestions: readonly string[] }
  /** Files whose shared lines aren't the home file's: no line of theirs opens in the home. */
  rewritten?: readonly string[]
  bot: { tools: Named; schedules: Named; eventSuggestions: Named }
  available: { skills: readonly { name: string; homePath: string | null }[] }
}

const MANIFEST_FIELD = /^bot\.json#(schedules|eventSuggestions|tools)\.(\d+)\./

function manifestSpot(
  flag: BotShareFlag,
  field: string,
  candidate: BotShareFlagSource
): Omit<BotShareFlagSpot, 'flag'> {
  const match = MANIFEST_FIELD.exec(flag.where)
  const { bot } = candidate
  if (match?.[1] === 'tools') {
    const tool = bot.tools[Number(match[2])]
    if (tool) {
      return { part: `tool:${tool.name}`, where: tool.name, file: tool.name, homePath: null }
    }
  }
  if (match?.[1] === 'schedules' || match?.[1] === 'eventSuggestions') {
    const index = Number(match[2])
    const shared = bot[match[1]][index]
    const automationId = candidate.automationIds[match[1]][index]
    if (shared && automationId) {
      const kind = match[1] === 'schedules' ? 'schedule' : 'event'
      return {
        part: `${kind}:${automationId}`,
        where: shared.name,
        file: shared.name,
        homePath: null
      }
    }
  }
  return { part: null, where: field, file: field, homePath: null }
}

function placeFlag(flag: BotShareFlag, candidate: BotShareFlagSource): BotShareFlagSpot {
  if (flag.where.startsWith('bot.json#')) {
    return { flag, ...manifestSpot(flag, flag.where.slice('bot.json#'.length), candidate) }
  }
  if (flag.where === 'SOUL.md') {
    return { flag, part: 'soul', where: 'SOUL.md', file: 'SOUL.md', homePath: 'SOUL.md' }
  }
  const memory = /^memory\/(.+)\.md$/.exec(flag.where)
  if (memory) {
    return {
      flag,
      part: `memory:${memory[1]}`,
      where: memory[1],
      file: flag.where,
      homePath: flag.where
    }
  }
  const skill = /^skills\/([^/]+)\/(.+)$/.exec(flag.where)
  const own = skill && candidate.available.skills.find((entry) => entry.name === skill[1])
  if (skill && own) {
    return {
      flag,
      part: `skill:${skill[1]}`,
      where: `${skill[1]} › ${skill[2]}`,
      file: skill[2],
      homePath: own.homePath === null ? null : `${own.homePath}/${skill[2]}`
    }
  }
  return { flag, part: null, where: flag.where, file: flag.where, homePath: null }
}

export function botShareFlagSpot(
  flag: BotShareFlag,
  candidate: BotShareFlagSource
): BotShareFlagSpot {
  const spot = placeFlag(flag, candidate)
  return candidate.rewritten?.includes(flag.where) ? { ...spot, homePath: null } : spot
}
