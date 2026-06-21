/* eslint-disable max-lines -- Why: the jcode chat store keeps the NDJSON event
   reducer, the live per-sessionKey external store, and its on-disk persistence
   backing (snapshot/hydrate/list/delete) together so the full conversation
   state contract is reviewable as one unit, mirroring persistence.ts. */
import { useSyncExternalStore } from 'react'
import type {
  JcodeChatEventMessage,
  JcodeConversationRecord,
  JcodeNdjsonEvent
} from '../../../../shared/jcode-chat-types'
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
  /** Selected custom provider profile name (from a `jcode provider add` profile).
   *  Mutually exclusive with composerProvider: when set, the turn is sent with
   *  `providerProfile` (-> `--provider-profile`) instead of `provider` (-> -p). */
  composerProviderProfile: string | undefined
}

const EMPTY_SESSION: ChatSessionState = {
  messages: [],
  isStreaming: false,
  statusDetail: null,
  resumeSessionId: undefined,
  streamingId: null,
  composerProvider: undefined,
  composerModel: undefined,
  composerProviderProfile: undefined
}

const sessions = new Map<string, ChatSessionState>()
const listeners = new Map<string, Set<() => void>>()

// Why (BUG 1, persistence): the live in-memory store is backed by disk in the
// main process. To write a full JcodeConversationRecord we need per-session
// context (worktreeId/cwd) that lives in ChatPane props, not in the event
// stream. ChatPane registers it on mount via setChatSessionContext so a snapshot
// written from anywhere (e.g. a turn that finished while the tab was hidden) is
// complete. Sessions seeded by rehydrate are also marked here.
type ChatSessionContext = { worktreeId?: string; cwd?: string }
const sessionContexts = new Map<string, ChatSessionContext>()

// Debounce timers per sessionKey so rapid turn-boundary saves coalesce and we
// never write on every text_delta.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** First non-empty user message, trimmed, as a human title for "Recent chats". */
function deriveTitle(state: ChatSessionState): string {
  const firstUser = state.messages.find((m) => m.role === 'user' && m.text.trim())
  const text = firstUser?.text.trim() ?? 'New chat'
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

function buildRecord(sessionKey: string, state: ChatSessionState): JcodeConversationRecord {
  const ctx = sessionContexts.get(sessionKey)
  return {
    sessionKey,
    worktreeId: ctx?.worktreeId,
    cwd: ctx?.cwd,
    title: deriveTitle(state),
    updatedAt: Date.now(),
    resumeSessionId: state.resumeSessionId,
    composerProvider: state.composerProvider,
    composerModel: state.composerModel,
    composerProviderProfile: state.composerProviderProfile,
    messages: state.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      ...(m.tools ? { tools: m.tools } : {}),
      ...(m.isError ? { isError: m.isError } : {})
    }))
  }
}

/** Persist a session snapshot to disk (debounced). Called on turn boundaries.
 *  No-op for empty conversations so we don't create files for blank tabs. */
function schedulePersist(sessionKey: string): void {
  const existing = saveTimers.get(sessionKey)
  if (existing) {
    clearTimeout(existing)
  }
  const timer = setTimeout(() => {
    saveTimers.delete(sessionKey)
    const state = sessions.get(sessionKey)
    if (!state || state.messages.length === 0) {
      return
    }
    void window.api.jcodeChat.saveConversation({ record: buildRecord(sessionKey, state) })
  }, 250)
  saveTimers.set(sessionKey, timer)
}

/** Register per-session context (worktreeId/cwd) for the disk record. Called by
 *  ChatPane on mount; safe to call repeatedly. */
export function setChatSessionContext(sessionKey: string, context: ChatSessionContext): void {
  sessionContexts.set(sessionKey, context)
}

const TURN_BOUNDARY_EVENTS = new Set(['start', 'done', 'error', 'stopped', 'exit'])

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
    // Why (BUG 1): persist on turn boundaries (done/error/stopped/exit), not on
    // every text_delta, so we capture the final transcript + --resume id without
    // thrashing disk. 'start' is handled at startChatTurn (records the prompt).
    if (TURN_BOUNDARY_EVENTS.has(message.event.type)) {
      schedulePersist(sessionKey)
    }
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
  // Why (BUG 1): persist at the start of a turn so the user prompt is durable
  // even if jcode crashes before emitting any event.
  schedulePersist(sessionKey)
}

/** Seed the in-memory store for a sessionKey from a loaded on-disk conversation.
 *  Called before/at ChatPane mount when reopening a known conversation so the
 *  rehydrated view matches the persisted transcript + --resume continuity. Does
 *  not overwrite a session that already has live messages (avoids clobbering a
 *  conversation that was kept in memory across a tab switch). */
export function hydrateChatSession(record: JcodeConversationRecord): void {
  const existing = sessions.get(record.sessionKey)
  if (existing && existing.messages.length > 0) {
    sessionContexts.set(record.sessionKey, {
      worktreeId: record.worktreeId,
      cwd: record.cwd
    })
    return
  }
  sessionContexts.set(record.sessionKey, {
    worktreeId: record.worktreeId,
    cwd: record.cwd
  })
  setSession(record.sessionKey, (state) => ({
    ...state,
    messages: record.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      tools: Array.isArray(m.tools) ? (m.tools as JcodeToolCall[]) : undefined,
      isError: m.isError
    })),
    // A rehydrated turn is never mid-stream.
    isStreaming: false,
    statusDetail: null,
    streamingId: null,
    resumeSessionId: record.resumeSessionId,
    composerProvider: record.composerProvider,
    composerModel: record.composerModel,
    composerProviderProfile: record.composerProviderProfile
  }))
}

export function setChatStatusDetail(sessionKey: string, detail: string | null): void {
  setSession(sessionKey, (state) => ({ ...state, statusDetail: detail }))
}

/** The composer chip selection. A built-in provider and a custom profile are
 *  mutually exclusive; "Auto" is `provider: undefined, providerProfile: undefined`. */
export type ChatComposerSelection = {
  provider?: string | undefined
  /** Custom profile name; when set, `provider` is ignored on send. */
  providerProfile?: string | undefined
  model?: string | undefined
}

/** Persist the composer's provider/profile/model selection per sessionKey so the
 *  chip choice survives tab switches (ChatPane unmount/remount). Pass everything
 *  undefined to mean "Auto". A built-in provider and a custom profile are
 *  mutually exclusive — selecting one clears the other. When `model` is omitted
 *  the previous model is kept. */
export function setChatComposerSelection(
  sessionKey: string,
  selection: ChatComposerSelection
): void {
  setSession(sessionKey, (state) => ({
    ...state,
    composerProvider: selection.providerProfile ? undefined : selection.provider,
    composerProviderProfile: selection.providerProfile,
    composerModel: 'model' in selection ? selection.model : state.composerModel
  }))
}

/** Drop a session's IN-MEMORY state. Called when its chat tab is closed so the
 *  Map does not grow unboundedly across the app's lifetime.
 *
 *  Why (BUG 1/2): this is in-memory eviction ONLY — it must NOT delete the
 *  on-disk transcript. A closed jcode chat stays in "Recent chats" and can be
 *  reopened + rehydrated. To flush the latest live state before evicting, we
 *  persist synchronously-ish (debounced timers are cleared and a final save is
 *  issued) so nothing typed before close is lost. Use deleteChatConversation to
 *  remove the durable record. */
export function disposeChatSession(sessionKey: string): void {
  const pending = saveTimers.get(sessionKey)
  if (pending) {
    clearTimeout(pending)
    saveTimers.delete(sessionKey)
  }
  const state = sessions.get(sessionKey)
  if (state && state.messages.length > 0) {
    void window.api.jcodeChat.saveConversation({ record: buildRecord(sessionKey, state) })
  }
  sessions.delete(sessionKey)
  listeners.delete(sessionKey)
  sessionContexts.delete(sessionKey)
}

/** Permanently delete a conversation's durable record (and evict memory). Used
 *  when the user removes a chat from "Recent chats". */
export function deleteChatConversation(sessionKey: string): void {
  const pending = saveTimers.get(sessionKey)
  if (pending) {
    clearTimeout(pending)
    saveTimers.delete(sessionKey)
  }
  sessions.delete(sessionKey)
  listeners.delete(sessionKey)
  sessionContexts.delete(sessionKey)
  void window.api.jcodeChat.deleteConversation(sessionKey)
}

/** List persisted conversations (newest first) for a "Recent chats" surface. */
export async function listChatConversations(): Promise<
  Awaited<ReturnType<typeof window.api.jcodeChat.listConversations>>
> {
  return window.api.jcodeChat.listConversations()
}

/** Load a persisted conversation record (transcript + context) by sessionKey. */
export async function loadChatConversation(
  sessionKey: string
): Promise<JcodeConversationRecord | null> {
  return window.api.jcodeChat.loadConversation(sessionKey)
}
