import type { Translate } from '@/i18n/use-translate'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { formatAutomationDateTime } from '../automation-page-parts'

/** "Run #N"; records from before run numbers fall back to when they were scheduled. */
export function formatAutomationRunLabel(
  run: Pick<AutomationRun, 'runNumber' | 'scheduledFor'>,
  t: Translate,
  intlLocale?: string
): string {
  return typeof run.runNumber === 'number'
    ? t('auto.components.automations.runIdentity.runNumber', 'Run #{{number}}', {
        number: run.runNumber
      })
    : formatAutomationDateTime(run.scheduledFor, t, intlLocale)
}

/** History is newest first, so "newer" is the previous entry. */
export function getAutomationRunNeighbors<T extends { id: string }>(
  runs: readonly T[],
  runId: string
): { newer: T | null; older: T | null } {
  const index = runs.findIndex((run) => run.id === runId)
  if (index === -1) {
    return { newer: null, older: null }
  }
  return { newer: runs[index - 1] ?? null, older: runs[index + 1] ?? null }
}

/** K/J step through runs only when focus is not typing into or inside a menu or dialog. */
export function getAutomationRunStepKey(event: {
  key: string
  defaultPrevented?: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  target?: EventTarget | null
}): 'newer' | 'older' | null {
  const step = event.key === 'k' ? 'newer' : event.key === 'j' ? 'older' : null
  if (
    !step ||
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return null
  }
  const target = event.target
  if (
    target instanceof Element &&
    ((target instanceof HTMLElement && target.isContentEditable) ||
      target.matches('input, textarea, select, [role="textbox"]') ||
      target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))
  ) {
    return null
  }
  return step
}
