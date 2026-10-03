import { useCallback, useEffect, type KeyboardEvent, type RefObject } from 'react'
import {
  isImeOwnedKeyboardEvent,
  useImeKeyGestureOwnership
} from '@/lib/ime-composition-keyboard-event'
import type { BrowserAddressBarPreview } from './browser-address-bar-edit-session'
import { useAddressBarSelectionAfterCommit } from './use-address-bar-selection-after-commit'

export type AddressBarPreview = Pick<BrowserAddressBarPreview, 'typedQuery' | 'selection'>

export type AddressBarSuggestionsState =
  | { kind: 'previewing'; preview: AddressBarPreview }
  | { kind: 'open' }
  | { kind: 'closed' }

export type AddressBarEscapeOutcome =
  | { kind: 'restore-typed-query'; preview: AddressBarPreview }
  | { kind: 'close-suggestions' }
  | { kind: 'revert-to-page'; committedAddress: string }
  | { kind: 'leave-for-page' }

/** Chrome's OmniboxEditModel::OnEscapeKeyPressed: each press takes the first rung that applies. */
export function resolveAddressBarEscape({
  suggestions,
  draft,
  committedAddress
}: {
  suggestions: AddressBarSuggestionsState
  draft: string
  committedAddress: string
}): AddressBarEscapeOutcome {
  if (suggestions.kind === 'previewing') {
    return { kind: 'restore-typed-query', preview: suggestions.preview }
  }
  if (suggestions.kind === 'open') {
    return { kind: 'close-suggestions' }
  }
  if (draft !== committedAddress) {
    return { kind: 'revert-to-page', committedAddress }
  }
  return { kind: 'leave-for-page' }
}

export type BrowserAddressBarEscapeBinding = {
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  committedAddress: string
  suggestionsShown: boolean
  previewRef: RefObject<AddressBarPreview | null>
  restoreTypedQuery: () => void
  closeSuggestions: () => void
  onChange: (value: string) => void
  onLeaveAddressBar: () => void
}

export function useBrowserAddressBarEscape({
  inputRef,
  value,
  committedAddress,
  suggestionsShown,
  previewRef,
  restoreTypedQuery,
  closeSuggestions,
  onChange,
  onLeaveAddressBar
}: BrowserAddressBarEscapeBinding): (event: KeyboardEvent<HTMLInputElement>) => void {
  const placeSelection = useAddressBarSelectionAfterCommit(inputRef, value)
  const imeEscape = useImeKeyGestureOwnership('Escape')

  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }
    const onKeyUp = (event: globalThis.KeyboardEvent): void => imeEscape.onKeyUp(event)
    input.addEventListener('keyup', onKeyUp)
    input.addEventListener('blur', imeEscape.reset)
    return () => {
      input.removeEventListener('keyup', onKeyUp)
      input.removeEventListener('blur', imeEscape.reset)
    }
  }, [imeEscape, inputRef])

  return useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Why: macOS Korean ends a composition on Escape with a marked keydown and then an
      // unmarked one. Chrome closes the list on the first and ignores the second.
      if (imeEscape.ownsKeyDown(event)) {
        event.stopPropagation()
        if (event.nativeEvent.isComposing && !previewRef.current && suggestionsShown) {
          closeSuggestions()
        }
        return
      }
      if (isImeOwnedKeyboardEvent(event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const preview = previewRef.current
      const outcome = resolveAddressBarEscape({
        suggestions: preview
          ? { kind: 'previewing', preview }
          : { kind: suggestionsShown ? 'open' : 'closed' },
        draft: value,
        committedAddress
      })
      switch (outcome.kind) {
        case 'restore-typed-query':
          restoreTypedQuery()
          placeSelection(outcome.preview.typedQuery, outcome.preview.selection)
          return
        case 'close-suggestions':
          closeSuggestions()
          return
        case 'revert-to-page':
          closeSuggestions()
          onChange(outcome.committedAddress)
          placeSelection(outcome.committedAddress, {
            start: 0,
            end: outcome.committedAddress.length,
            direction: 'backward'
          })
          return
        case 'leave-for-page':
          onLeaveAddressBar()
      }
    },
    [
      closeSuggestions,
      committedAddress,
      imeEscape,
      onChange,
      onLeaveAddressBar,
      placeSelection,
      previewRef,
      restoreTypedQuery,
      suggestionsShown,
      value
    ]
  )
}
