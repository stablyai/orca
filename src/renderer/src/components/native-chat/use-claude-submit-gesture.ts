import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  agentResolvesSubmitKeybinding,
  getClaudeSubmitGesture,
  isClaudeSubmitResolved,
  primeClaudeSubmit,
  primeComposerSubmitBytes,
  subscribeClaudeSubmitResolved
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

/** True while a local Claude-family pane is still reading its submit keybinding.
 *  The composer holds its send during this window so a pre-resolve default CR
 *  can't submit a remapped-Enter user's message as a newline. Resolves within a
 *  few ms of mount (or immediately when there is no keybindings source). */
export function useClaudeSubmitGesturePending(agent: AgentType, isRemotePane: boolean): boolean {
  useEffect(() => {
    primeComposerSubmitBytes(agent)
  }, [agent])
  const resolved = useSyncExternalStore(subscribeClaudeSubmitResolved, isClaudeSubmitResolved)
  return agentResolvesSubmitKeybinding(agent) && !isRemotePane && !resolved
}

/** The chat composer's submit-gesture wiring: the keydown matcher plus whether the
 *  send must hold until the keybinding resolves. */
export function useComposerSubmitGesture(
  agent: AgentType,
  isRemotePane: boolean
): { matchesSubmitKey: (event: SubmitKeyEvent) => boolean; submitGesturePending: boolean } {
  return {
    matchesSubmitKey: useComposerSubmitKeyMatch(agent, isRemotePane),
    submitGesturePending: useClaudeSubmitGesturePending(agent, isRemotePane)
  }
}
