import { useSyncExternalStore } from 'react'
import type {
  JcodeChatAttachment,
  JcodeChatEventMessage,
  JcodeConversationRecord,
  JcodeConversationSummary
} from '../../../../shared/jcode-chat-types'
import { buildJcodeConversationRecord, chatMessagesFromRecord } from './chat-session-record'
import { reduceJcodeEvent } from './chat-session-reducer'
import type { ChatSessionContext, ChatSessionState } from './chat-session-types'
export type {
  ChatMessage,
  ChatRole,
  ChatSessionContext,
  ChatSessionState
} from './chat-session-types'

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

/** Fired on the renderer DOM whenever the durable jcode conversation set may
 *  have changed (a turn boundary persisted, or a conversation was deleted).
 *  Best-effort signal for lightweight "Recent chats" surfaces (e.g. the sidebar
 *  per-worktree list) to re-fetch without polling. */
export const JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT = 'jcode-chat:conversations-changed'

const EMPTY_SESSION: ChatSessionState = {
  messages: [],
  isStreaming: false,
  statusDetail: null,
  resumeSessionId: undefined,
  streamingId: null,
  composerProvider: undefined,
  composerModel: undefined,
  composerProviderProfile: undefined,
  pendingAttachments: []
}

const sessions = new Map<string, ChatSessionState>()
const listeners = new Map<string, Set<() => void>>()

// Why (BUG 1, persistence): the live in-memory store is backed by disk in the
// main process. To write a full JcodeConversationRecord we need per-session
// context (worktreeId/cwd) that lives in ChatPane props, not in the event
// stream. ChatPane registers it on mount via setChatSessionContext so a snapshot
// written from anywhere (e.g. a turn that finished while the tab was hidden) is
// complete. Sessions seeded by rehydrate are also marked here.
const sessionContexts = new Map<string, ChatSessionContext>()

// Debounce timers per sessionKey so rapid turn-boundary saves coalesce and we
// never write on every text_delta.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getJcodeChatApi(): typeof window.api.jcodeChat | null {
  if (typeof window === 'undefined') {
    return null
  }
  // Why: sidebar/card tests and web shells can render without Electron preload;
  // persisted jcode chats are simply unavailable in that environment.
  return window.api?.jcodeChat ?? null
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
    void getJcodeChatApi()?.saveConversation({
      record: buildJcodeConversationRecord(sessionKey, state, sessionContexts.get(sessionKey))
    })
    // Why: notify best-effort listeners (e.g. the sidebar per-worktree "Recent
    // chats" list) that the durable conversation set changed on a turn boundary,
    // so they can re-fetch without polling. Renderer-only DOM event; harmless in
    // non-DOM test envs guarded by the typeof check.
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT))
    }
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

let ipcSubscribed = false

/** Subscribe the module to the jcode chat IPC stream exactly once. Routes each
 *  event into its session's reducer regardless of which tab is mounted. */
function ensureIpcSubscription(): void {
  if (ipcSubscribed) {
    return
  }
  const api = getJcodeChatApi()
  if (!api) {
    return
  }
  ipcSubscribed = true
  api.onEvent((message: JcodeChatEventMessage) => {
    const sessionKey = message.sessionKey
    // Only reduce for sessions we know about (a chat tab that has sent at least
    // one prompt). Ignore stray events for unknown keys.
    if (!sessions.has(sessionKey)) {
      return
    }
    setSession(sessionKey, (state) => reduceJcodeEvent(state, message.event))
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
    messages: chatMessagesFromRecord(record),
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

/** Append composer attachments (files and/or text blobs) for the next turn.
 *  De-dupes file attachments by absolute path so re-picking the same file is a
 *  no-op. Stored in the per-sessionKey external store so chips survive a tab
 *  switch before the user hits send. */
export function addChatAttachments(sessionKey: string, attachments: JcodeChatAttachment[]): void {
  if (attachments.length === 0) {
    return
  }
  setSession(sessionKey, (state) => {
    const existingPaths = new Set(
      state.pendingAttachments.filter((a) => a.kind === 'file').map((a) => a.path)
    )
    const next = state.pendingAttachments.slice()
    for (const attachment of attachments) {
      if (attachment.kind === 'file') {
        if (existingPaths.has(attachment.path)) {
          continue
        }
        existingPaths.add(attachment.path)
      }
      next.push(attachment)
    }
    return { ...state, pendingAttachments: next }
  })
}

/** Remove one pending attachment by index (chip ✕). */
export function removeChatAttachment(sessionKey: string, index: number): void {
  setSession(sessionKey, (state) => ({
    ...state,
    pendingAttachments: state.pendingAttachments.filter((_, i) => i !== index)
  }))
}

/** Clear all pending attachments (called after a turn is dispatched). */
export function clearChatAttachments(sessionKey: string): void {
  setSession(sessionKey, (state) =>
    state.pendingAttachments.length === 0 ? state : { ...state, pendingAttachments: [] }
  )
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
  // Kill any in-flight jcode child for this pane. Without this, closing a chat
  // tab mid-turn leaves the spawned jcode process running (and burning tokens)
  // with no UI attached to it. The main-side handler safely no-ops when there is
  // no active child, so calling it unconditionally is harmless.
  const api = getJcodeChatApi()
  api?.stop({ sessionKey })
  const pending = saveTimers.get(sessionKey)
  if (pending) {
    clearTimeout(pending)
    saveTimers.delete(sessionKey)
  }
  const state = sessions.get(sessionKey)
  if (state && state.messages.length > 0) {
    void api?.saveConversation({
      record: buildJcodeConversationRecord(sessionKey, state, sessionContexts.get(sessionKey))
    })
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
  void getJcodeChatApi()?.deleteConversation(sessionKey)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT))
  }
}

/** List persisted conversations (newest first) for a "Recent chats" surface. */
export async function listChatConversations(): Promise<JcodeConversationSummary[]> {
  return (await getJcodeChatApi()?.listConversations()) ?? []
}

/** Load a persisted conversation record (transcript + context) by sessionKey. */
export async function loadChatConversation(
  sessionKey: string
): Promise<JcodeConversationRecord | null> {
  return (await getJcodeChatApi()?.loadConversation(sessionKey)) ?? null
}
