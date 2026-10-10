import type { AutomationRun } from '../../../../shared/automations-types'

export type AutomationRunHistoryArrowKey = 'ArrowUp' | 'ArrowDown'

export function isAutomationRunHistoryArrowKey(key: string): key is AutomationRunHistoryArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown'
}

export function shouldHandleAutomationRunHistoryKey(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  nativeEvent?: { isComposing?: boolean }
  target?: EventTarget | null
}): boolean {
  if (
    (!isAutomationRunHistoryArrowKey(event.key) && event.key !== 'Enter') ||
    Boolean(event.nativeEvent?.isComposing) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false
  }

  const target = event.target
  if (target instanceof HTMLElement) {
    if (
      target.isContentEditable ||
      target.matches(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]'
      )
    ) {
      return false
    }
    if (target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) {
      return false
    }
    // Enter belongs to the focused control; a focused run row is a button that opens itself on click.
    if (
      event.key === 'Enter' &&
      target.closest(
        'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"]'
      )
    ) {
      return false
    }
  }

  return true
}

export function getAutomationRunHistoryArrowTarget(args: {
  runs: readonly AutomationRun[]
  selectedRunId: string | null
  key: AutomationRunHistoryArrowKey
}): AutomationRun | null {
  const { runs, selectedRunId, key } = args
  if (runs.length === 0) {
    return null
  }
  const currentIndex = selectedRunId ? runs.findIndex((run) => run.id === selectedRunId) : 0
  if (currentIndex < 0) {
    return runs[key === 'ArrowDown' ? 0 : runs.length - 1] ?? null
  }
  const nextIndex = key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1
  if (nextIndex < 0 || nextIndex >= runs.length) {
    return runs[currentIndex] ?? null
  }
  return runs[nextIndex] ?? null
}
