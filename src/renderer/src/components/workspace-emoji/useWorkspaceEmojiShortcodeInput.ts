import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import {
  applyWorkspaceEmojiSuggestion,
  getActiveWorkspaceEmojiShortcode,
  replaceCompletedWorkspaceEmojiShortcode,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiReplacement,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'

type WorkspaceEmojiShortcodeInputOptions = {
  disabled?: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onValueChange: (value: string) => void
  value: string
}

export function useWorkspaceEmojiShortcodeInput({
  disabled = false,
  inputRef,
  onValueChange,
  value
}: WorkspaceEmojiShortcodeInputOptions) {
  const [cursor, setCursor] = useState<number | null>(null)
  const [commandValue, setCommandValue] = useState('')
  const focusFrameRef = useRef<number | null>(null)
  const activeShortcode = useMemo(
    () => getActiveWorkspaceEmojiShortcode(value, cursor),
    [cursor, value]
  )
  const suggestions = useMemo(
    () => (activeShortcode ? searchWorkspaceEmojiShortcodes(activeShortcode.query) : []),
    [activeShortcode]
  )
  const open = !disabled && activeShortcode !== null && suggestions.length > 0
  const resolvedCommandValue = suggestions.some(
    (suggestion) => `emoji:${suggestion.shortcode}` === commandValue
  )
    ? commandValue
    : suggestions[0]
      ? `emoji:${suggestions[0].shortcode}`
      : ''
  const selectedSuggestion =
    suggestions.find((suggestion) => `emoji:${suggestion.shortcode}` === resolvedCommandValue) ??
    null

  const cancelFocusFrame = useCallback(() => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  useEffect(() => cancelFocusFrame, [cancelFocusFrame])

  const applyReplacement = useCallback(
    (replacement: WorkspaceEmojiReplacement) => {
      onValueChange(replacement.value)
      setCursor(null)
      cancelFocusFrame()
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null
        inputRef.current?.focus({ preventScroll: true })
        inputRef.current?.setSelectionRange(replacement.cursor, replacement.cursor)
      })
    },
    [cancelFocusFrame, inputRef, onValueChange]
  )

  const handleValueChange = useCallback(
    (
      nextValue: string,
      nextCursor: number | null = inputRef.current?.selectionStart ?? nextValue.length
    ) => {
      const completedEmoji = replaceCompletedWorkspaceEmojiShortcode(nextValue, nextCursor)
      if (completedEmoji) {
        applyReplacement(completedEmoji)
        return
      }
      onValueChange(nextValue)
      setCursor(nextCursor)
    },
    [applyReplacement, inputRef, onValueChange]
  )

  const syncCursor = useCallback(
    (input = inputRef.current) => setCursor(input?.selectionStart ?? null),
    [inputRef]
  )

  const close = useCallback(() => setCursor(null), [])

  const selectSuggestion = useCallback(
    (suggestion: WorkspaceEmojiSuggestion) => {
      if (!activeShortcode) {
        return
      }
      applyReplacement(applyWorkspaceEmojiSuggestion(value, activeShortcode, suggestion))
    },
    [activeShortcode, applyReplacement, value]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
      if (!open) {
        return false
      }
      if (isImeCompositionKeyDown(event)) {
        event.stopPropagation()
        return true
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        const selectedIndex = suggestions.findIndex(
          (suggestion) => `emoji:${suggestion.shortcode}` === resolvedCommandValue
        )
        const direction = event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (selectedIndex + direction + suggestions.length) % suggestions.length
        setCommandValue(`emoji:${suggestions[nextIndex].shortcode}`)
        return true
      }
      const acceptsSuggestion =
        (event.key === 'Enter' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey) ||
        (event.key === 'Tab' && !event.shiftKey)
      if (acceptsSuggestion && selectedSuggestion) {
        event.preventDefault()
        event.stopPropagation()
        selectSuggestion(selectedSuggestion)
        return true
      }
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        return true
      }
      return false
    },
    [close, open, resolvedCommandValue, selectSuggestion, selectedSuggestion, suggestions]
  )

  return {
    close,
    commandValue: resolvedCommandValue,
    handleKeyDown,
    handleValueChange,
    onCommandValueChange: setCommandValue,
    open,
    selectSuggestion,
    suggestions,
    syncCursor
  }
}
