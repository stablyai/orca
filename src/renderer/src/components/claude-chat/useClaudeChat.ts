import React, { useEffect, useReducer } from 'react'
import { reduceChat, initialChatState } from './chat-message-model'
import type { ChatState, ChatAction } from './chat-message-model'

type SendOpts = {
  model?: string
  effort?: string
  attachments?: string[]
}

type SendMessageFn = (text: string, opts?: SendOpts) => void
type StopFn = () => void
type LoadSessionFn = (sessionId: string) => Promise<void>
type NewChatFn = () => void

type UseClaudeChatResult = {
  state: ChatState
  sendMessage: SendMessageFn
  stop: StopFn
  loadSession: LoadSessionFn
  newChat: NewChatFn
  dispatch: React.Dispatch<ChatAction>
}

export function useClaudeChat(worktreeId: string | null, cwd: string | null): UseClaudeChatResult {
  const [state, dispatch] = useReducer(reduceChat, undefined, initialChatState)

  useEffect(() => {
    if (!worktreeId) {
      return
    }
    // Subscribe to events from the main process for this worktree only.
    const cleanup = window.api.claudeChat.onEvent((payload) => {
      if (payload.worktreeId !== worktreeId) {
        return
      }
      dispatch({ kind: 'event', event: payload.event as { type: string; [k: string]: unknown } })
    })
    return cleanup
  }, [worktreeId])

  useEffect(() => {
    // Why: each worktree keeps its own conversation. On switch, clear the view
    // then restore this worktree's live session transcript from disk.
    let cancelled = false
    dispatch({ kind: 'loadTranscript', events: [], sessionId: '' })
    if (!worktreeId || !cwd) {
      return
    }
    void (async () => {
      const status = await window.api.claudeChat.status({ worktreeId })
      if (cancelled || !status.sessionId) {
        return
      }
      const events = await window.api.claudeChat.loadSession({
        cwd,
        sessionId: status.sessionId
      })
      if (cancelled) {
        return
      }
      dispatch({ kind: 'loadTranscript', events, sessionId: status.sessionId })
      if (status.running) {
        dispatch({ kind: 'setRunning', running: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [worktreeId, cwd])

  const sendMessage: SendMessageFn = (text, opts) => {
    if (!worktreeId || !cwd || !text.trim()) {
      return
    }
    dispatch({ kind: 'localUser', text })
    dispatch({ kind: 'setRunning', running: true })
    void window.api.claudeChat.send({ worktreeId, cwd, text, ...opts })
  }

  const stop: StopFn = () => {
    if (!worktreeId) {
      return
    }
    window.api.claudeChat.stop({ worktreeId })
    dispatch({ kind: 'setRunning', running: false })
  }

  const loadSession: LoadSessionFn = async (sessionId) => {
    if (!worktreeId || !cwd) {
      return
    }
    const events = await window.api.claudeChat.loadSession({ cwd, sessionId })
    dispatch({ kind: 'loadTranscript', events, sessionId })
    // Why: resume wires the next send to --resume so the conversation continues.
    window.api.claudeChat.resume({ worktreeId, cwd, sessionId })
  }

  const newChat: NewChatFn = () => {
    if (!worktreeId) {
      return
    }
    window.api.claudeChat.reset({ worktreeId })
    // Why: empty events clears the conversation; sessionId '' signals "no session".
    dispatch({ kind: 'loadTranscript', events: [], sessionId: '' })
  }

  return { state, sendMessage, stop, loadSession, newChat, dispatch }
}
