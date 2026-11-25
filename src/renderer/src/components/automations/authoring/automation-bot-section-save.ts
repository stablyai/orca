import {
  AUTOMATION_CHANGED,
  automationEditPrecondition,
  sameAutomationEditValue,
  type AutomationEditPrecondition
} from '../../../../../shared/automations/automation-edit-precondition'
import { translate } from '@/i18n/i18n'
import type {
  Automation,
  AutomationBotTarget,
  AutomationUpdateInput
} from '../../../../../shared/automations/automation-definition'
import { isValidAutomationSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-parsing'
import { acceptsAutomationDraftSchedule } from '../../../../../shared/automations/scheduling/automation-schedule-input-gate'
import type { AutomationDraft } from './AutomationEditorDialog'
import { botScheduleUpdates, botTargetError } from './automation-bot-save'
import { botResultsPlace } from '../../../../../shared/automation-bot-target'
import {
  isSameBotTarget,
  withBotResultsPlace
} from '../../../../../shared/automations/bot-automation-target-edit'
import { parseDraftTime } from './automation-draft-model'

export type BotAutomationSection = 'when' | 'results'
export type BotAutomationEditBase = Pick<
  Automation,
  'rrule' | 'dtstart' | 'timezone' | 'timezoneExplicit' | 'on' | 'bot'
>

export function botAutomationEditBase(automation: Automation): BotAutomationEditBase {
  const { rrule, dtstart, timezone, timezoneExplicit, on, bot } = automation
  return { rrule, dtstart, timezone, timezoneExplicit, on, bot }
}

/** The fields a section's editor starts from and a save checks are unchanged. */
export function botSectionBase(
  section: BotAutomationSection,
  automation: BotAutomationEditBase
): unknown {
  return section === 'when'
    ? {
        rrule: automation.rrule,
        dtstart: automation.dtstart,
        timezone: automation.timezone,
        timezoneExplicit: automation.timezoneExplicit === true,
        on: automation.on ?? []
      }
    : {
        resultsTo: automation.bot?.resultsTo ?? null,
        letBotReact: automation.bot?.letBotReact === true
      }
}

export const sameBotSectionBase = sameAutomationEditValue

/** Why the When draft can't be saved, or null. */
export function botWhenDraftError(draft: AutomationDraft): string | null {
  if (draft.eventsOnly) {
    return null
  }
  if (draft.scheduleWarning) {
    return translate(
      'auto.components.automations.AutomationsPage.64bdb2304f',
      'Pick a supported schedule before saving.'
    )
  }
  if (
    draft.preset === 'custom' &&
    !acceptsAutomationDraftSchedule({
      customSchedule: draft.customSchedule,
      savedRrule: draft.savedSchedule,
      validate: isValidAutomationSchedule
    })
  ) {
    return translate(
      'auto.components.automations.AutomationsPage.6e91dab317',
      'Enter a valid advanced schedule before saving.'
    )
  }
  return null
}

/** The section's patch; empty when nothing in it changed. */
export function botSectionPatch(
  section: BotAutomationSection,
  current: BotAutomationEditBase,
  draft: AutomationDraft,
  now: number
): AutomationUpdateInput {
  if (section === 'when') {
    return botScheduleUpdates(draft, current, { ...parseDraftTime(draft.time), now })
  }
  const target =
    draft.bot && current.bot
      ? { ...current.bot, resultsTo: draft.bot.resultsTo, letBotReact: draft.bot.letBotReact }
      : null
  if (!target) {
    return {}
  }
  const trimmed: AutomationBotTarget =
    typeof target.resultsTo === 'object'
      ? {
          ...target,
          resultsTo: withBotResultsPlace(target.resultsTo, botResultsPlace(target.resultsTo).trim())
        }
      : target
  return isSameBotTarget(current.bot, trimmed) ? {} : { bot: trimmed }
}

export function botSectionDraftError(
  section: BotAutomationSection,
  draft: AutomationDraft
): string | null {
  if (section === 'when') {
    return botWhenDraftError(draft)
  }
  return draft.bot ? botTargetError(draft.bot) : null
}

export type BotSectionSaveResult =
  | { kind: 'saved'; automation: Automation }
  | { kind: 'unchanged' }
  /** Someone else changed this section since the editor opened; nothing was written. */
  | { kind: 'conflict'; latest: Automation }

/**
 * Re-reads, checks the section is as the editor found it (unless `force`, the owner's Save mine),
 * then writes only the section's fields with a host-checked snapshot.
 */
export async function saveBotAutomationSection({
  section,
  base,
  draft,
  force,
  now,
  reread,
  write
}: {
  section: BotAutomationSection
  /** `botSectionBase` of the record the editor opened on. */
  base: unknown
  draft: AutomationDraft
  force: boolean
  now: number
  reread: () => Promise<Automation>
  write: (
    updates: AutomationUpdateInput,
    unchangedSince: AutomationEditPrecondition
  ) => Promise<Automation>
}): Promise<BotSectionSaveResult> {
  const latest = await reread()
  if (!force && !sameBotSectionBase(botSectionBase(section, latest), base)) {
    return { kind: 'conflict', latest }
  }
  const patch = botSectionPatch(section, latest, draft, now)
  if (Object.keys(patch).length === 0) {
    return { kind: 'unchanged' }
  }
  try {
    return { kind: 'saved', automation: await write(patch, automationEditPrecondition(latest)) }
  } catch (error) {
    if (error instanceof Error && error.message === AUTOMATION_CHANGED) {
      return { kind: 'conflict', latest: await reread() }
    }
    throw error
  }
}
