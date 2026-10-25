import {
  useImperativeHandle,
  useMemo,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type Ref,
  type RefObject
} from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultListRow } from './AiVaultVirtualRow'

export type AiVaultSessionListKeyboard = {
  /** Plain ↑/↓ move the selection and Enter opens it; a handled key is default-prevented. */
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

export type AiVaultSessionSelection = {
  /** Row index of the selected session, or null when nothing is selectable. */
  selectedIndex: number | null
  select: (index: number) => void
  /** Moves one session up or down, clamped at the ends; returns the new row index. */
  move: (delta: 1 | -1) => number | null
}

/** Stores the chosen row and its session; the row is derived again once the list changes, and a
 *  new `query` starts over at the top match. */
export function useAiVaultSessionSelection(
  rows: readonly AiVaultListRow[],
  enabled: boolean,
  query: string
): AiVaultSessionSelection {
  const [stored, setStored] = useState<{ index: number; sessionId: string; query: string } | null>(
    null
  )
  // A pick belongs to the search it was made under; editing the search back must not revive it.
  if (stored !== null && stored.query !== query) {
    setStored(null)
  }
  const chosen = stored?.query === query ? stored : null
  const sessionIndexes = useMemo(
    () => rows.flatMap((row, index) => (row.type === 'session' ? [index] : [])),
    [rows]
  )
  // The chosen row while it still shows its session, so a session listed twice stays two rows.
  const chosenIndex =
    chosen === null
      ? undefined
      : sessionIdAt(rows, chosen.index) === chosen.sessionId
        ? chosen.index
        : sessionIndexes.find((index) => sessionIdAt(rows, index) === chosen.sessionId)
  const selectedIndex = enabled ? (chosenIndex ?? sessionIndexes[0] ?? null) : null
  const select = (index: number): void => {
    const sessionId = sessionIdAt(rows, index)
    if (sessionId !== null) {
      setStored({ index, sessionId, query })
    }
  }
  return {
    selectedIndex,
    select,
    move: (delta) => {
      if (selectedIndex === null) {
        return null
      }
      const position = sessionIndexes.indexOf(selectedIndex) + delta
      const next = sessionIndexes[Math.min(Math.max(position, 0), sessionIndexes.length - 1)]
      select(next)
      return next
    }
  }
}

/** Exposes the selection to the panel, which forwards keys from its search box. */
export function useAiVaultSessionListKeyboard(
  ref: Ref<AiVaultSessionListKeyboard> | undefined,
  args: {
    rows: readonly AiVaultListRow[]
    selection: AiVaultSessionSelection
    scrollToIndex: (index: number) => void
    activate: (session: AiVaultSession, index: number) => void
  }
): void {
  const { rows, selection, scrollToIndex, activate } = args
  const { selectedIndex } = selection
  const selectedRow = selectedIndex === null ? undefined : rows[selectedIndex]
  const selectedSession = selectedRow?.type === 'session' ? selectedRow.session : null

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const index = selection.move(event.key === 'ArrowDown' ? 1 : -1)
          if (index !== null) {
            event.preventDefault()
            scrollToIndex(index)
          }
          return
        }
        if (event.key === 'Enter' && selectedSession && selectedIndex !== null) {
          event.preventDefault()
          // A held Enter must not start the same session twice while the first open is underway.
          if (!event.repeat) {
            activate(selectedSession, selectedIndex)
          }
        }
      }
    }),
    [activate, scrollToIndex, selectedIndex, selectedSession, selection]
  )
}

/** Panel root props: a clicked row cannot take focus, so it lands on the root and the row keys keep working. */
export function aiVaultPanelKeyboardRootProps(
  keyboardRef: RefObject<AiVaultSessionListKeyboard | null> | undefined
): Pick<HTMLAttributes<HTMLElement>, 'tabIndex' | 'onKeyDown'> {
  if (!keyboardRef) {
    return {}
  }
  return {
    tabIndex: -1,
    onKeyDown: (event) => {
      if (event.target === event.currentTarget) {
        keyboardRef.current?.handleKeyDown(event)
      }
    }
  }
}

function sessionIdAt(rows: readonly AiVaultListRow[], index: number): string | null {
  const row = rows[index]
  return row?.type === 'session' ? row.session.id : null
}
