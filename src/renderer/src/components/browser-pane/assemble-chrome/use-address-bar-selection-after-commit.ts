import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { BrowserAddressBarSelection } from './browser-address-bar-edit-session'

type PendingSelection = {
  forValue: string
  selection: BrowserAddressBarSelection
  canApply: (input: HTMLInputElement) => boolean
}

const always = (): boolean => true

/**
 * Puts a selection on the bar once it holds the value the selection belongs to. React parks the
 * caret at the end when it commits a controlled value, so a selection set before that is lost.
 */
export function useAddressBarSelectionAfterCommit(
  inputRef: RefObject<HTMLInputElement | null>,
  value: string
): (
  forValue: string,
  selection: BrowserAddressBarSelection,
  canApply?: (input: HTMLInputElement) => boolean
) => void {
  const pendingRef = useRef<PendingSelection | null>(null)

  const apply = useCallback(
    (pending: PendingSelection): void => {
      const input = inputRef.current
      if (input && pending.canApply(input)) {
        input.setSelectionRange(
          pending.selection.start,
          pending.selection.end,
          pending.selection.direction
        )
      }
    },
    [inputRef]
  )

  useLayoutEffect(() => {
    const pending = pendingRef.current
    if (pending?.forValue === value) {
      pendingRef.current = null
      apply(pending)
    }
  }, [apply, value])

  return useCallback(
    (forValue, selection, canApply = always) => {
      const pending = { forValue, selection, canApply }
      if (inputRef.current?.value === forValue) {
        pendingRef.current = null
        apply(pending)
        return
      }
      pendingRef.current = pending
    },
    [apply, inputRef]
  )
}
