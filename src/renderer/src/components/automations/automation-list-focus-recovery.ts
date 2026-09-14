/**
 * Where focus goes when the row the user was on disappears.
 *
 * A refresh, a host filter change, or a delete can remove the focused row while
 * the keyboard is still in the list. Without this, focus falls back to the
 * document body and the next Tab restarts from the top of the page. The order —
 * next row, then previous row, then the host picker — keeps the user near where
 * they were, and the picker is the last resort because it is the control that
 * put them in this list to begin with.
 */

export type AutomationListFocusTarget = { kind: 'row'; rowKey: string } | { kind: 'picker' }

export type AutomationListFocusRecoveryInput = {
  /** Row order before the change, including the row that is now gone. */
  previousRowKeys: readonly string[]
  nextRowKeys: readonly string[]
  /** The row that had focus; null when focus was elsewhere. */
  focusedRowKey: string | null
}

/** Null means focus is fine where it is and must not be moved. */
export function resolveAutomationListFocusRecovery(
  input: AutomationListFocusRecoveryInput
): AutomationListFocusTarget | null {
  const { focusedRowKey } = input
  if (focusedRowKey === null) {
    return null
  }
  const surviving = new Set(input.nextRowKeys)
  if (surviving.has(focusedRowKey)) {
    return null
  }
  const lostIndex = input.previousRowKeys.indexOf(focusedRowKey)
  if (lostIndex === -1) {
    // The row was never in this list, so nothing here can be the right neighbor.
    return { kind: 'picker' }
  }
  for (let index = lostIndex + 1; index < input.previousRowKeys.length; index += 1) {
    const candidate = input.previousRowKeys[index]
    if (surviving.has(candidate)) {
      return { kind: 'row', rowKey: candidate }
    }
  }
  for (let index = lostIndex - 1; index >= 0; index -= 1) {
    const candidate = input.previousRowKeys[index]
    if (surviving.has(candidate)) {
      return { kind: 'row', rowKey: candidate }
    }
  }
  return { kind: 'picker' }
}
