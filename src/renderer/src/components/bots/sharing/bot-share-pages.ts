// The Share dialog's pages and what each page reads and changes.
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotShareCandidateSummary,
  BotShareLeftOut
} from '../../../../../shared/bots/bot-package'
import type { BotShareFlagSpot } from './bot-share-flags'
import type { BotShareSelection } from './bot-share-rpc'
import { BOT_SHARE_MAX_PICKS } from '../../../../../shared/rpc-contract/bots-share-params'
import { pickedSkillNames } from '../../../../../shared/bots/bot-share-skill-picks'

export type BotShareList =
  | 'skills'
  | 'automations'
  | 'tools'
  | 'memory'
  | 'note'
  | 'check'
  | 'notIncluded'

export type BotSharePage =
  | { kind: 'list'; list: BotShareList }
  | { kind: 'part'; part: string; title: string; detail?: string; showNames?: boolean }

export type BotShareContext = {
  bot: Bot
  candidate: BotShareCandidateSummary
  selection: BotShareSelection
  /** The candidate was built from `selection` as it is now. */
  committed: boolean
  select: (change: Partial<BotShareSelection>) => void
  spots: BotShareFlagSpot[]
  open: (page: BotSharePage) => void
  goToLine: (spot: BotShareFlagSpot) => void
  note: string
  setNote: (note: string) => void
}

/** The picked names of a part: an absent list is all of them. */
export function pickedOf(names: readonly string[] | undefined, all: readonly string[]): string[] {
  return names ? all.filter((name) => names.includes(name)) : [...all]
}

export function toggled(picked: readonly string[], name: string, on: boolean): string[] {
  return on ? [...picked, name] : picked.filter((entry) => entry !== name)
}

/** Every memory file a share can carry: all of them, or the first BOT_SHARE_MAX_PICKS when there are more. */
export function allMemory(notes: readonly { topic: string }[]): string[] {
  return notes.slice(0, BOT_SHARE_MAX_PICKS).map((note) => note.topic)
}

const UNPACKABLE_SKILL = new Set(['link', 'size', 'unreadable'])

/** Skills the packager can't read (a link inside, too big): shown off so the owner sees why. */
export function unpackableSkills(leftOut: readonly BotShareLeftOut[]): BotShareLeftOut[] {
  return leftOut.filter((entry) => entry.kind === 'skill' && UNPACKABLE_SKILL.has(entry.why))
}

/** The ticked skills. One linked into a project from outside it shows ticked only once a candidate
 *  built from these picks carries it (the main process drops one the owner didn't tick there). */
export function pickedSkills(ctx: {
  candidate: {
    bot: { skills: readonly { name: string }[] }
    available: { skills: readonly { name: string; optInFrom?: string }[] }
  }
  selection: BotShareSelection
  committed: boolean
}): string[] {
  const { available, bot } = ctx.candidate
  return pickedSkillNames(ctx.selection.skills, available.skills).filter(
    (name) =>
      !ctx.committed ||
      bot.skills.some((skill) => skill.name === name) ||
      available.skills.find((skill) => skill.name === name)?.optInFrom === undefined
  )
}
