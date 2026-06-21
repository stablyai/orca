import { useSyncExternalStore } from 'react'
import type { JcodeChatEventMessage, JcodeNdjsonEvent } from '../../../../shared/jcode-chat-types'
import type { JcodeToolCall } from './JcodeToolCard'

// Why (BUG 1, persistence): the jcode chat conversation used to live in
// ChatPane's component-local React state. Because TabGroupPanel only mounts
// ChatPane while its tab is active, switching to another tab unmounted the
// component and destroyed the messages AND the jcode --resume session id, so
// returning to the tab showed an empty conversation with broken continuity.
//
// This module hoists that state into a tiny external store keyed by sessionKey
// (the chat tab id). The store subscribes to the 'jcode-chat:event' IPC stream
// once at module load — independent of whether any ChatPane is mounted — so
// deltas keep flowing into the right session even while its tab is hidden.
// ChatPane becomes a thin view that reads/writes this store, so unmount/remount
// is lossless and --resume continuity survives tab switches.

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  id: string
  role: ChatRole
  text: string
  /** Tool calls seen during this assistant turn, in arrival order. */
  tools?: JcodeToolCall[]
  isError?: boolean
}

export type ChatSessionState = {
  messages: ChatMessage[]
  isStreaming: boolean
  statusDetail: string | null
  /** jcode session id to pass as --resume on the next turn. */
  resumeSessionId: string | undefined
  /** Id of the assistant message currently being streamed into, if any. */
  streamingId: string | null
  /** Composer toolbar selection (Claude-style provider/model chip). Persisted
   *  per sessionKey so it survives ChatPane unmount/remount on tab switches.
   *  `undefined` provider means "Auto" (let ChatPane's default apply). */
  composerProvider: string | undefined
  composerModel: string | undefined
}

const EMPTY_SESSION: ChatSessionState = {
  messages: [],
  isStreaming: false,
  statusDetail: null,
  resumeSessionId: undefined,
  streamingId: null,
  composerProvider: undefined,
  composerModel: undefined
}

const sessions = new Map<string, ChatSessionState>()
const listeners = new Map<string, Set<() => void>>()

function getSession(sessionKey: string): ChatSessionState {
  return sessions.get(sessionKey) ?? EMPTY_SESSION
}

function emit(sessionKey: string): void {
  const set = listeners.get(sessionKey)
  if (set) {
    for (const listener of set) {
      listener()
    }
  }
}

function setSession(
  sessionKey: string,
  mutate: (state: ChatSessionState) => ChatSessionState
): void {
  const next = mutate(getSession(sessionKey))
  sessions.set(sessionKey, next)
  emit(sessionKey)
}

function strField(event: JcodeNdjsonEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

/** Insert-or-update a tool call on the streaming assistant message by id. */
function upsertTool(
  state: ChatSessionState,
  id: string,
  mutate: (call: JcodeToolCall) => JcodeToolCall,
  fallbackName = 'tool'
): ChatSessionState {
  const targetId = state.streamingId
  if (!targetId) {
    return state
  }
  return {
    ...state,
    messages: state.messages.map((m) => {
      if (m.id !== targetId) {
        return m
      }
      const tools = m.tools ?? []
      const index = tools.findIndex((t) => t.id === id)
      if (index === -1) {
        const created = mutate({ id, name: fallbackName, rawInput: '', status: 'running' })
        return { ...m, tools: [...tools, created] }
      }
      const next = tools.slice()
      next[index] = mutate(next[index])
      return { ...m, tools: next }
    })
  }
}

function appendToStreaming(
  state: ChatSessionState,
  mutate: (msg: ChatMessage) => ChatMessage
): ChatSessionState {
  const targetId = state.streamingId
  if (!targetId) {
    return state
  }
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === targetId ? mutate(m) : m))
  }
}

function finalizeTurn(state: ChatSessionState): ChatSessionState {
  return { ...state, isStreaming: false, statusDetail: null, streamingId: null }
}

function reduceEvent(state: ChatSessionState, event: JcodeNdjsonEvent): ChatSessionState {
  switch (event.type) {
    case 'start': {
      const id = strField(event, 'session_id')
      return id ? { ...state, resumeSessionId: id } : state
    }
    case 'status_detail': {
      const detail = strField(event, 'detail')
      return detail ? { ...state, statusDetail: detail } : state
    }
    case 'connection_phase': {
      const phase = strField(event, 'phase')
      return phase ? { ...state, statusDetail: phase } : state
    }
    case 'text_delta': {
      const text = strField(event, 'text') ?? ''
      if (!text) {
        return state
      }
      return appendToStreaming({ ...state, statusDetail: null }, (m) => ({
        ...m,
        text: m.text + text
      }))
    }
    case 'tool_start': {
      const id = strField(event, 'id') ?? `tool-${Date.now()}`
      const name = strField(event, 'name') ?? 'tool'
      return upsertTool(state, id, (call) => ({ ...call, name }), name)
    }
    case 'tool_input': {
      const id = strField(event, 'id')
      const delta = strField(event, 'delta') ?? ''
      if (!id) {
        return state
      }
      return upsertTool(state, id, (call) => ({ ...call, rawInput: call.rawInput + delta }))
    }
    case 'tool_exec': {
      const id = strField(event, 'id') ?? `tool-${Date.now()}`
      const name = strField(event, 'name') ?? 'tool'
      return upsertTool(state, id, (call) => ({ ...call, status: 'running' }), name)
    }
    case 'tool_done': {
      const id = strField(event, 'id')
      const errorText = strField(event, 'error')
      const output = strField(event, 'output')
      if (!id) {
        return state
      }
      return upsertTool(state, id, (call) => ({
        ...call,
        output: output ?? call.output,
        error: errorText ?? undefined,
        status: errorText ? 'error' : 'done'
      }))
    }
    case 'done': {
      const id = strField(event, 'session_id')
      let next = id ? { ...state, resumeSessionId: id } : state
      const finalText = strField(event, 'text')
      if (finalText) {
        next = appendToStreaming(next, (m) => (m.text ? m : { ...m, text: finalText }))
      }
      return finalizeTurn(next)
    }
    case 'error': {
      const message =
        strField(event, 'error') ?? strField(event, 'message') ?? 'Unknown jcode error'
      const next = appendToStreaming(state, (m) => ({
        ...m,
        text: m.text + message,
        isError: true
      }))
      return finalizeTurn(next)
    }
    case 'stopped': {
      const next = appendToStreaming(state, (m) => ({
        ...m,
        text: m.text ? `${m.text}\n\n(stopped)` : '(stopped)'
      }))
      return finalizeTurn(next)
    }
    case 'exit': {
      return state.streamingId ? finalizeTurn(state) : state
    }
    default:
      return state
  }
}

let ipcSubscribed = false

/** Subscribe the module to the jcode chat IPC stream exactly once. Routes each
 *  event into its session's reducer regardless of which tab is mounted. */
function ensureIpcSubscription(): void {
  if (ipcSubscribed) {
    return
  }
  ipcSubscribed = true
  window.api.jcodeChat.onEvent((message: JcodeChatEventMessage) => {
    const sessionKey = message.sessionKey
    // Only reduce for sessions we know about (a chat tab that has sent at least
    // one prompt). Ignore stray events for unknown keys.
    if (!sessions.has(sessionKey)) {
      return
    }
    setSession(sessionKey, (state) => reduceEvent(state, message.event))
  })
}

export function subscribeChatSession(sessionKey: string, listener: () => void): () => void {
  ensureIpcSubscription()
  let set = listeners.get(sessionKey)
  if (!set) {
    set = new Set()
    listeners.set(sessionKey, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) {
      listeners.delete(sessionKey)
    }
  }
}

export function getChatSessionSnapshot(sessionKey: string): ChatSessionState {
  return getSession(sessionKey)
}

export function useChatSession(sessionKey: string): ChatSessionState {
  return useSyncExternalStore(
    (listener) => subscribeChatSession(sessionKey, listener),
    () => getChatSessionSnapshot(sessionKey)
  )
}

/** Record a user prompt + create the assistant placeholder, marking the session
 *  streaming. Returns nothing; the view re-renders via the store subscription. */
export function startChatTurn(sessionKey: string, prompt: string): void {
  const userId = `user-${Date.now()}`
  const assistantId = `assistant-${Date.now()}`
  setSession(sessionKey, (state) => ({
    ...state,
    messages: [
      ...state.messages,
      { id: userId, role: 'user', text: prompt },
      { id: assistantId, role: 'assistant', text: '' }
    ],
    streamingId: assistantId,
    isStreaming: true,
    statusDetail: 'Thinking…'
  }))
}

export function setChatStatusDetail(sessionKey: string, detail: string | null): void {
  setSession(sessionKey, (state) => ({ ...state, statusDetail: detail }))
}

/** Persist the composer's provider/model selection per sessionKey so the chip
 *  choice survives tab switches (ChatPane unmount/remount). Pass `undefined`
 *  provider to mean "Auto". Setting a provider clears the model unless one is
 *  given, since models are provider-specific. */
export function setChatComposerSelection(
  sessionKey: string,
  selection: { provider: string | undefined; model?: string | undefined }
): void {
  setSession(sessionKey, (state) => ({
    ...state,
    composerProvider: selection.provider,
    composerModel: 'model' in selection ? selection.model : state.composerModel
  }))
}

/** Drop a session's state. Called when its chat tab is closed so the Map does
 *  not grow unboundedly across the app's lifetime. */
export function disposeChatSession(sessionKey: string): void {
  sessions.delete(sessionKey)
  listeners.delete(sessionKey)
}
