// When an agent's status gives its terminal tab a generated title: one rule for the window's
// store and for main's layout, which derives the titles itself in a layout-owner build.

import { deriveGeneratedTabTitle } from './agent-tab-title'
import {
  getAgentRowGeneratedTitleText,
  getOrcaDispatchTaskId,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from './agent-row-primary-text'
import type { AgentStatusEntry } from './agent-status-types'

type TitleStatus = Pick<AgentStatusEntry, 'orchestration' | 'prompt'>

/** The titles of a tab a generated title must not cover or replace. */
export type GeneratedTitleTab = {
  customTitle?: string | null
  quickCommandLabel?: string | null
  generatedTitle?: string | null
}

/** A user's rename or a quick command's label: a generated title never goes on such a tab. */
export function tabHasProtectedTitle(tab: GeneratedTitleTab): boolean {
  return Boolean(tab.customTitle?.trim() || tab.quickCommandLabel?.trim())
}

/** Sticky orchestration titles are replaced only when they still describe this dispatch. */
export function generatedTitleReplacesExisting(entry: TitleStatus): boolean {
  const hasMatchingOrchestrationLabels = Boolean(
    (entry.orchestration?.displayName?.trim() || entry.orchestration?.taskTitle?.trim()) &&
    orchestrationLabelsMatchLiveDispatch(entry)
  )
  const liveDispatchTaskId = isOrcaDispatchPrompt(entry.prompt)
    ? getOrcaDispatchTaskId(entry.prompt)
    : null
  const stickyOrchestrationTaskId = entry.orchestration?.taskId?.trim() || null
  return (
    hasMatchingOrchestrationLabels ||
    Boolean(
      liveDispatchTaskId &&
      stickyOrchestrationTaskId &&
      liveDispatchTaskId !== stickyOrchestrationTaskId
    )
  )
}

/** The text a status's title is derived from: a dispatch's task, not its preamble. */
export function generatedTitleSourceText(entry: TitleStatus): string {
  return isOrcaDispatchPrompt(entry.prompt) ? getAgentRowGeneratedTitleText(entry) : entry.prompt
}

/** The generated title this status gives the tab, or null when the tab keeps what it shows. */
export function generatedTabTitleForStatus(
  entry: TitleStatus,
  tab: GeneratedTitleTab
): { title: string; replaceExisting: boolean } | null {
  if (tabHasProtectedTitle(tab)) {
    return null
  }
  const replaceExisting = generatedTitleReplacesExisting(entry)
  const existing = tab.generatedTitle?.trim()
  if (existing && !replaceExisting) {
    return null
  }
  const source = generatedTitleSourceText(entry)
  const title = source.length > 0 ? deriveGeneratedTabTitle(source) : null
  return title && title !== existing ? { title, replaceExisting } : null
}
