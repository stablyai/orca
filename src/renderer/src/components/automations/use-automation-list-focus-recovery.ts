import { useEffect, useRef } from 'react'
import { resolveAutomationListFocusRecovery } from './automation-list-focus-recovery'

/**
 * Keeps keyboard focus inside the list when the row it was on disappears.
 *
 * The focused row has to be recorded as the user moves through the list, not
 * read when the change lands: by then the row is unmounted and the browser has
 * already dropped focus to `<body>`, which is exactly the state this repairs.
 * Focus is only moved when it was in this list and was actually lost — a user
 * who has tabbed away is left alone.
 */

export const AUTOMATION_ROW_ID_ATTRIBUTE = 'data-automation-row-id'

export type AutomationListFocusRecoveryOptions = {
  rowKeys: readonly string[]
  containerRef: React.RefObject<HTMLElement | null>
  /** Focused as the last resort — it is the control that produced this list. */
  fallbackRef: React.RefObject<HTMLElement | null>
}

function focusRow(container: HTMLElement, rowKey: string): boolean {
  const selector = `[${AUTOMATION_ROW_ID_ATTRIBUTE}="${CSS.escape(rowKey)}"]`
  const row = container.querySelector<HTMLElement>(selector)
  row?.focus()
  return row !== null
}

/** The fallback is a wrapper, so focus the control inside it rather than the box. */
function focusFallback(fallback: HTMLElement | null): void {
  const focusable = fallback?.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')
  ;(focusable ?? fallback)?.focus()
}

export function useAutomationListFocusRecovery({
  rowKeys,
  containerRef,
  fallbackRef
}: AutomationListFocusRecoveryOptions): void {
  const focusedRowKeyRef = useRef<string | null>(null)
  const previousRowKeysRef = useRef<readonly string[]>(rowKeys)

  // Document-level: focus moving to the search field or any other control outside
  // the list must erase the memory, and that event never reaches the container.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const container = containerRef.current
      const target = event.target
      if (!container || !(target instanceof HTMLElement) || !container.contains(target)) {
        focusedRowKeyRef.current = null
        return
      }
      focusedRowKeyRef.current =
        target
          .closest(`[${AUTOMATION_ROW_ID_ATTRIBUTE}]`)
          ?.getAttribute(AUTOMATION_ROW_ID_ATTRIBUTE) ?? null
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [containerRef])

  useEffect(() => {
    const previousRowKeys = previousRowKeysRef.current
    previousRowKeysRef.current = rowKeys
    const container = containerRef.current
    if (!container) {
      return
    }
    // Focus still somewhere in the list means nothing was lost to repair.
    if (container.contains(document.activeElement)) {
      return
    }
    const target = resolveAutomationListFocusRecovery({
      previousRowKeys,
      nextRowKeys: rowKeys,
      focusedRowKey: focusedRowKeyRef.current
    })
    if (!target) {
      return
    }
    focusedRowKeyRef.current = null
    if (target.kind === 'row' && focusRow(container, target.rowKey)) {
      return
    }
    focusFallback(fallbackRef.current)
  }, [rowKeys, containerRef, fallbackRef])
}
