import { useCallback, useEffect } from 'react'
import { getClaudeSubmitGesture, primeClaudeSubmit } from './native-chat-claude-submit-cache'
import { claudeSubmitGestureMatchesKeyboardEvent } from './native-chat-claude-submit-keybinding'

type SubmitKeyEvent = {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Primes the user's Claude submit gesture and returns a predicate for whether a
 *  keydown should submit. Lets a comment input mirror the same Enter/newline split
 *  the user configured for Claude chat, so a remapped Enter inserts a newline
 *  instead of finishing the comment. */
export function useClaudeSubmitGestureMatch(): (event: SubmitKeyEvent) => boolean {
  useEffect(() => {
    primeClaudeSubmit()
  }, [])
  return useCallback(
    (event: SubmitKeyEvent) =>
      claudeSubmitGestureMatchesKeyboardEvent(getClaudeSubmitGesture(), event),
    []
  )
}
