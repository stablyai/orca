// The Share dialog's pages and what each page reads and changes.
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'

type BotShareAvailableSkills = BotShareCandidateSummary['available']['skills']
import type { BotShareFlagSpot } from '../../../../../shared/bots/bot-share-flag-spots'
import type { BotShareSelection } from './bot-share-rpc'
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

/** The ticked skills: one linked into a project from outside it only with the owner's tick on it. */
export function pickedSkills(selection: BotShareSelection, available: BotShareAvailableSkills) {
  return pickedSkillNames(selection.skills, available, selection.outsideSkills)
}
