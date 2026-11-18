import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

/** Arrowing through the dropdown fills the bar with the row while remembering what was typed. */
export function useBrowserAddressBarSuggestionPreview({
  prePreviewValueRef,
  autocompleteQuery,
  suggestions,
  setSelectedValueOverride,
  onChange,
  clearInline,
  showInline
}: {
  prePreviewValueRef: MutableRefObject<string | null>
  autocompleteQuery: string
  suggestions: BrowserAddressBarSuggestion[]
  setSelectedValueOverride: Dispatch<SetStateAction<string | null>>
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
    setSelectedValueOverride(null)
    clearInline()
  }, [clearInline, prePreviewValueRef, setSelectedValueOverride])

  const previewSuggestion = useCallback(
    (url: string): void => {
      if (prePreviewValueRef.current === null) {
        prePreviewValueRef.current = autocompleteQuery
      }
      setSelectedValueOverride(url)
      onChange(url)
    },
    [autocompleteQuery, onChange, prePreviewValueRef, setSelectedValueOverride]
  )

  const selectSuggestionAtIndex = useCallback(
    (index: number): void => {
      const suggestion = suggestions[index]
      if (!suggestion) {
        return
      }
      if (suggestion.isSearch) {
        // Keep the typed query for search rows; Enter must not substitute the search URL into the bar.
        prePreviewValueRef.current = null
        clearInline()
        setSelectedValueOverride(suggestion.url)
        onChange(autocompleteQuery)
        return
      }
      if (suggestion.inlineText !== undefined) {
        // Restore the selected completion tail while retaining the typed query for Escape.
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
    prePreviewValueRef.current = null
    setSelectedValueOverride(null)
    clearInline()
    onChange(typed)
  }, [clearInline, onChange, prePreviewValueRef, setSelectedValueOverride])

  return { clearSuggestionPreview, selectSuggestionAtIndex, restoreTypedQuery }
}
