import { useCallback, useEffect } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  agentResolvesSubmitKeybinding,
  getClaudeSubmitGesture,
  primeClaudeSubmit,
  primeComposerSubmitBytes
} from './native-chat-claude-submit-cache'
import { claudeSubmitGestureMatchesKeyboardEvent } from './native-chat-claude-submit-keybinding'

export type SubmitKeyEvent = {
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

/** Whether a chat composer keydown should submit. A local Claude pane mirrors the
 *  user's resolved submit gesture (a remapped Enter inserts a newline); every
 *  other pane keeps the default Enter, with Shift+Enter for a newline. Remote
 *  panes stay on the default because their keybindings live on the host. */
export function useComposerSubmitKeyMatch(
  agent: AgentType,
  isRemotePane: boolean
): (event: SubmitKeyEvent) => boolean {
  useEffect(() => {
    primeComposerSubmitBytes(agent)
  }, [agent])
  return useCallback(
    (event: SubmitKeyEvent) => {
      if (agentResolvesSubmitKeybinding(agent) && !isRemotePane) {
        return claudeSubmitGestureMatchesKeyboardEvent(getClaudeSubmitGesture(), event)
      }
      return event.key === 'Enter' && !event.shiftKey
    },
    [agent, isRemotePane]
  )
}
