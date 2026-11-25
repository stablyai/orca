// Unsaved When/Results edits from the bot panel's Automation screen, kept when the screen unmounts
// because the owner switched bot, tab or workspace, so coming back restores them. Only Back,
// Escape and the crumb ask to discard. At most four automations hold one, so none is ever dropped
// silently: a fifth edit can't start until one is saved or discarded. Lost on app restart.
import type { AutomationDraft } from '../automations/authoring/AutomationEditorDialog'
import type {
  BotAutomationSection,
  BotAutomationEditBase
} from '../automations/authoring/automation-bot-section-save'
import {
  retainAutomationPayload,
  releaseAutomationPayload
} from '../automations/details/automation-detail-retention'

export const BOT_AUTOMATION_DRAFT_CAP = 4

export type RetainedBotAutomationDraft = {
  section: BotAutomationSection
  draft: AutomationDraft
  savedAutomation: BotAutomationEditBase
  /** The section as the editor found it, for the save's conflict check. */
  base: unknown
}

const drafts = new Map<string, RetainedBotAutomationDraft>()

export function readRetainedBotAutomationDraft(
  screenKey: string
): RetainedBotAutomationDraft | null {
  return drafts.get(screenKey) ?? null
}

export function retainBotAutomationDraft(
  screenKey: string,
  draft: RetainedBotAutomationDraft
): boolean {
  if (!retainAutomationPayload(`draft:${screenKey}`, draft, 'draft')) {
    return false
  }
  drafts.set(screenKey, draft)
  return true
}

export function discardBotAutomationDraft(screenKey: string): void {
  drafts.delete(screenKey)
  releaseAutomationPayload(`draft:${screenKey}`)
}

/** Another automation's edit would be the fifth kept one. */
export function botAutomationDraftsFull(screenKey: string): boolean {
  let others = 0
  for (const key of drafts.keys()) {
    if (key !== screenKey) {
      others += 1
    }
  }
  return others >= BOT_AUTOMATION_DRAFT_CAP
}

/** Test seam. */
export function clearRetainedBotAutomationDrafts(): void {
  for (const key of drafts.keys()) {
    releaseAutomationPayload(`draft:${key}`)
  }
  drafts.clear()
}
