import { useCallback, type MutableRefObject, type RefObject } from 'react'
import {
  readBrowserAddressBarSelection,
  type BrowserAddressBarSelection
} from './browser-address-bar-edit-session'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

/**
 * Arrowing onto a suggestion previews its URL in the bar while the typed text is kept aside, so
 * Escape, ArrowUp and blur can put back what was typed and where the caret sat.
 */
export function useBrowserAddressBarSuggestionPreview({
  inputRef,
  suggestions,
  autocompleteQuery,
  prePreviewValueRef,
  previewSelectionRef,
  setSelectedValueOverride,
  onChange,
  clearInline,
  showInline
}: {
  inputRef: RefObject<HTMLInputElement | null>
  suggestions: BrowserAddressBarSuggestion[]
  autocompleteQuery: string
  /** The typed text while the bar shows a previewed or inline-completed suggestion. */
  prePreviewValueRef: MutableRefObject<string | null>
  /** Where the caret sat before the preview replaced the text; null means at the end. */
  previewSelectionRef: MutableRefObject<BrowserAddressBarSelection | null>
  setSelectedValueOverride: (url: string | null) => void
  onChange: (value: string) => void
  clearInline: () => void
  showInline: (typed: string, text: string) => void
}): {
  clearSuggestionPreview: () => void
  selectSuggestionAtIndex: (index: number) => void
  restoreTypedQuery: () => void
} {
  const clearSuggestionPreview = useCallback((): void => {
    prePreviewValueRef.current = null
    previewSelectionRef.current = null
    setSelectedValueOverride(null)
    clearInline()
  }, [clearInline, prePreviewValueRef, previewSelectionRef, setSelectedValueOverride])

  const previewSuggestion = useCallback(
    (url: string): void => {
      const input = inputRef.current
      if (prePreviewValueRef.current === null) {
        prePreviewValueRef.current = autocompleteQuery
        previewSelectionRef.current = input ? readBrowserAddressBarSelection(input) : null
      }
      setSelectedValueOverride(url)
      onChange(url)
    },
    [
      autocompleteQuery,
      inputRef,
      onChange,
      prePreviewValueRef,
      previewSelectionRef,
      setSelectedValueOverride
    ]
  )

  const selectSuggestionAtIndex = useCallback(
    (index: number): void => {
      const suggestion = suggestions[index]
      if (!suggestion) {
        return
      }
      if (suggestion.isSearch) {
        // Why: the search row is what Enter does with the typed query, so the bar keeps the
        // typed text instead of the search URL.
        prePreviewValueRef.current = null
        previewSelectionRef.current = null
        clearInline()
        setSelectedValueOverride(suggestion.url)
        onChange(autocompleteQuery)
        return
      }
      if (suggestion.inlineText !== undefined) {
        // Why: like Chrome, the completion comes back as typed text plus a selected tail, so
        // Escape still restores what was typed.
        setSelectedValueOverride(suggestion.url)
        showInline(autocompleteQuery, suggestion.inlineText)
        onChange(suggestion.inlineText)
        return
      }
      previewSuggestion(suggestion.url)
    },
    [
      autocompleteQuery,
      clearInline,
      onChange,
      prePreviewValueRef,
      previewSelectionRef,
      previewSuggestion,
      setSelectedValueOverride,
      showInline,
      suggestions
    ]
  )

  const restoreTypedQuery = useCallback((): void => {
    const typed = prePreviewValueRef.current
    if (typed === null) {
      return
    }
    clearSuggestionPreview()
    onChange(typed)
  }, [clearSuggestionPreview, onChange, prePreviewValueRef])

  return { clearSuggestionPreview, selectSuggestionAtIndex, restoreTypedQuery }
}
