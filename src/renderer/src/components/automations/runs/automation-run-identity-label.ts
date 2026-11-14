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

/** Runs normally start within seconds of their slot; past this, start and slot are labeled. */
export const RUN_START_DRIFT_LABEL_MS = 60_000

/**
 * When a run actually launched, or null.
 * - Dispatched and completed runs launched at their dispatch time; older records without
 *   one keep their start time.
 * - A failed terminal run gets `dispatchedAt` only once it was dispatched, so that time is
 *   durable launch evidence even after terminal retention clears its pane key.
 * - A failed chat run launched only if it reached a chat session: the chat launcher stamps
 *   `dispatchedAt` even when it refuses or throws before starting anything.
 * - Skipped and missed runs never launched; their `startedAt` is an observation time.
 */
export function getAutomationRunLaunchedAt(
  run: Pick<
    AutomationRun,
    'status' | 'dispatchedAt' | 'startedAt' | 'chatSessionId' | 'terminalPaneKey' | 'sessionKind'
  >
): number | null {
  if (run.status === 'completed' || run.status === 'dispatched') {
    return run.dispatchedAt ?? run.startedAt
  }
  if (run.status !== 'dispatch_failed') {
    return null
  }
  if (run.sessionKind === 'chat') {
    return run.chatSessionId ? (run.dispatchedAt ?? run.startedAt) : null
  }
  return run.dispatchedAt ?? (run.terminalPaneKey ? run.startedAt : null)
}
