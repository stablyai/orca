// The Share dialog's pages and what each page reads and changes.
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotShareCandidateSummary,
  BotShareLeftOut
} from '../../../../../shared/bots/bot-package'

type BotShareAvailableSkills = BotShareCandidateSummary['available']['skills']
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

const UNPACKABLE_SKILL = new Set(['link', 'size', 'unreadable', 'limit'])

/** Skills the packager can't read (a link inside, too big): shown off so the owner sees why. */
export function unpackableSkills(leftOut: readonly BotShareLeftOut[]): BotShareLeftOut[] {
  return leftOut.filter((entry) => entry.kind === 'skill' && UNPACKABLE_SKILL.has(entry.why))
}

/** The ticked skills: one linked into a project from outside it only with the owner's tick on it. */
export function pickedSkills(selection: BotShareSelection, available: BotShareAvailableSkills) {
  return pickedSkillNames(selection.skills, available, selection.outsideSkills)
}
