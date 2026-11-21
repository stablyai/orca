// A message the next send replies to, kept per draft scope apart from the draft record so the
// draft schema stays unchanged; small and bounded, so localStorage holds it across reloads.

import { useSyncExternalStore } from 'react'
import type { NativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-storage'
import {
  NATIVE_CHAT_REPLY_EXCERPT_MAX,
  nativeChatReplyExcerpt,
  nativeChatReplyQuoteOf
} from './native-chat-reply-quote'
import {
  NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS,
  nativeChatReplySourceOf
} from './native-chat-reply-sources'
import { resolveNativeChatComposerDraftOwner } from '../../drafts/native-chat-composer-draft-memory'

export type NativeChatReplyTarget = {
  /** Unique per Reply click: a send consumes only the target it captured, never a newer one. */
  readonly id: string
  readonly messageId: string
  readonly author: 'agent' | 'user'
  /** The agent name a restored quote was written with, kept when it is sent again. */
  readonly agentLabel?: string
  /** The workspace whose chat this is, so removing the workspace forgets the reply. */
  readonly owner?: NativeChatComposerDraftOwner
  /** What the strip shows and the quote carries; the agent already holds the full message. */
  readonly excerpt: string
}

/** Scopes remembered at once; older targets are dropped first. */
export const NATIVE_CHAT_REPLY_TARGETS_MAX = 30
const STORAGE_KEY = 'orca.nativeChat.replyTargets.v1'

const targets = new Map<string, NativeChatReplyTarget>()
const listeners = new Map<string, Set<() => void>>()
/** Scopes whose last reply the user cancelled, so the strip can say so; a send clears silently. */
const cancelled = new Set<string>()
/** Bumped whenever a scope's reply is decided (picked, cancelled, deleted); a failed send may put its
 *  reply back only while nothing has decided since it took it. */
const custody = new Map<string, number>()
/** Who owns each scope's reply, kept after a send takes it so deleting the workspace still decides it. */
const custodyOwners = new Map<string, NativeChatComposerDraftOwner>()
/** Scopes that live only while an editor is open (a queued-message edit): never saved, released on close. */
const ephemeral = new Set<string>()
const decide = (scopeKey: string): void => {
  custody.set(scopeKey, (custody.get(scopeKey) ?? 0) + 1)
}

export function nativeChatReplyCustody(scopeKey: string): number {
  return custody.get(scopeKey) ?? 0
}
let loaded = false
let sequence = 0

function isTarget(value: unknown): value is NativeChatReplyTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'messageId' in value &&
    typeof value.messageId === 'string' &&
    'author' in value &&
    (value.author === 'agent' || value.author === 'user') &&
    'excerpt' in value &&
    typeof value.excerpt === 'string'
  )
}

function load(): void {
  if (loaded) {
    return
  }
  loaded = true
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const entries: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(entries)) {
      return
    }
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && isTarget(entry[1])) {
        const [scopeKey, target] = entry
        targets.set(scopeKey, {
          ...target,
          // By characters, as excerpts are cut, so a reload never splits one.
          excerpt: Array.from(target.excerpt).slice(0, NATIVE_CHAT_REPLY_EXCERPT_MAX).join('')
        })
        // Tracked like a reply picked this session, so deleting its chat still fences a pending send.
        custody.set(scopeKey, custody.get(scopeKey) ?? 0)
        if (target.owner) {
          custodyOwners.set(scopeKey, target.owner)
        }
      }
    }
  } catch {
    // Unreadable or blocked storage only costs the remembered strip, never the draft.
  }
}

function save(): void {
  try {
    const kept = [...targets].filter(([scopeKey]) => !ephemeral.has(scopeKey))
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // Quota or blocked storage: the target still works for this session.
  }
}

/** Saves after a change to these scopes, unless they are all editor-only and so never stored. */
function saveFor(scopeKeys: readonly string[]): void {
  if (scopeKeys.some((key) => !ephemeral.has(key))) {
    save()
  }
}

function notify(scopeKey: string): void {
  for (const listener of listeners.get(scopeKey) ?? []) {
    listener()
  }
}

export function createNativeChatReplyTarget(
  message: Omit<NativeChatReplyTarget, 'id' | 'excerpt'> & { text: string }
): NativeChatReplyTarget {
  sequence += 1
  return {
    id: `${Date.now().toString(36)}-${sequence}`,
    messageId: message.messageId,
    author: message.author,
    excerpt: nativeChatReplyExcerpt(message.text)
  }
}

export function readNativeChatReplyTarget(scopeKey: string): NativeChatReplyTarget | null {
  load()
  return targets.get(scopeKey) ?? null
}

/** `ephemeral`: the scope lives only while an editor is open, so its reply is never saved. */
export function setNativeChatReplyTarget(
  scopeKey: string,
  target: NativeChatReplyTarget,
  options: { ephemeral?: boolean } = {}
): void {
  load()
  decide(scopeKey)
  cancelled.delete(scopeKey)
  if (options.ephemeral) {
    ephemeral.add(scopeKey)
  }
  // Every reply belongs to its chat's workspace, including one rebuilt from sent text, so removing
  // the workspace forgets it.
  const owner = target.owner ?? resolveNativeChatComposerDraftOwner(scopeKey)
  targets.delete(scopeKey)
  targets.set(scopeKey, owner && !target.owner ? { ...target, owner } : target)
  if (owner) {
    custodyOwners.set(scopeKey, owner)
  }
  // Only saved replies count toward the cap: an editor's reply never pushes out a chat's.
  const durable = [...targets.keys()].filter((key) => !ephemeral.has(key))
  const evicted = durable.slice(0, Math.max(0, durable.length - NATIVE_CHAT_REPLY_TARGETS_MAX))
  for (const key of evicted) {
    targets.delete(key)
  }
  saveFor([scopeKey, ...evicted])
  notify(scopeKey)
  // A mounted strip for a dropped scope must not keep showing a reply the send can no longer read.
  for (const key of evicted) {
    notify(key)
  }
}

/** The user dropped the reply (Cancel or Esc); true when there was one. */
export function cancelNativeChatReplyTarget(scopeKey: string): boolean {
  const current = readNativeChatReplyTarget(scopeKey)
  if (!current) {
    return false
  }
  clearNativeChatReplyTarget(scopeKey, current.id)
  decide(scopeKey)
  cancelled.add(scopeKey)
  return true
}

export function nativeChatReplyWasCancelled(scopeKey: string): boolean {
  return cancelled.has(scopeKey)
}

/** Esc in a message box: drops that box's reply, if it has one, before anything else Esc does there. */
export function cancelNativeChatReplyFrom(target: EventTarget | null): boolean {
  const scopeKey =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-native-chat-composer-scope]')?.dataset
          .nativeChatComposerScope
      : undefined
  return scopeKey ? cancelNativeChatReplyTarget(scopeKey) : false
}

/** Puts back a reply a refused send had taken, unless its reply was decided since `takenAt`
 *  (another picked or cancelled, or the chat deleted). Without `takenAt` (words handed back to the
 *  box), only into an empty slot. True when the scope now holds this reply. */
export function restoreNativeChatReplyTarget(
  scopeKey: string,
  target: NativeChatReplyTarget,
  takenAt?: number
): boolean {
  const current = readNativeChatReplyTarget(scopeKey)
  if (takenAt === undefined && current) {
    // A repeated hand-back of the same words finds its own reply already there; the same words
    // answering a different known message are another reply, not this one.
    return (
      current.author === target.author &&
      current.excerpt === target.excerpt &&
      current.agentLabel === target.agentLabel &&
      sameOriginal(current.messageId, target.messageId)
    )
  }
  if (takenAt !== undefined && nativeChatReplyCustody(scopeKey) !== takenAt) {
    return false
  }
  setNativeChatReplyTarget(scopeKey, target)
  return true
}

/** Whether two replies can be to the same message: yes unless both name different known originals. */
function sameOriginal(a: string, b: string): boolean {
  const unknown = (id: string): boolean => !id || id === NATIVE_CHAT_REPLY_SOURCE_AMBIGUOUS
  return unknown(a) || unknown(b) || a === b
}

/** A send left the box: it takes the reply it quoted (if still that one) and ends any "Reply cancelled"
 *  notice. True when it took the reply. */
export function settleNativeChatReplySend(scopeKey: string, replyId?: string): boolean {
  const hadNotice = cancelled.delete(scopeKey)
  const took = replyId !== undefined && clearNativeChatReplyTarget(scopeKey, replyId)
  if (hadNotice && !took) {
    notify(scopeKey)
  }
  return took
}

/** Forgets replies for drafts that are deleted, such as a closed chat or removed workspace; a pending
 *  send in those chats can no longer put its reply back. */
export function clearNativeChatReplyTargetsWhere(
  matches: (scopeKey: string, owner: NativeChatComposerDraftOwner | undefined) => boolean
): void {
  load()
  for (const key of custody.keys()) {
    if (matches(key, targets.get(key)?.owner ?? custodyOwners.get(key))) {
      decide(key)
      custodyOwners.delete(key)
    }
  }
  const removed = [...targets]
    .filter(([key, target]) => matches(key, target.owner))
    .map(([key]) => key)
  if (removed.length === 0) {
    return
  }
  for (const key of removed) {
    targets.delete(key)
  }
  saveFor(removed)
  for (const key of removed) {
    notify(key)
  }
}

/** An editor-only scope closed: its reply and all bookkeeping go; nothing can be sent from it any more. */
export function releaseNativeChatReplyScope(scopeKey: string): void {
  load()
  const had = targets.delete(scopeKey)
  custody.delete(scopeKey)
  custodyOwners.delete(scopeKey)
  cancelled.delete(scopeKey)
  if (had) {
    saveFor([scopeKey])
    notify(scopeKey)
  }
  ephemeral.delete(scopeKey)
}

/** Clears the scope's target; with `id`, only when it is still that target, so a newer Reply survives a send. */
export function clearNativeChatReplyTarget(scopeKey: string, id?: string): boolean {
  load()
  const current = targets.get(scopeKey)
  if (!current || (id !== undefined && current.id !== id)) {
    return false
  }
  cancelled.delete(scopeKey)
  targets.delete(scopeKey)
  saveFor([scopeKey])
  notify(scopeKey)
  return true
}

function subscribe(scopeKey: string, listener: () => void): () => void {
  let set = listeners.get(scopeKey)
  if (!set) {
    set = new Set()
    listeners.set(scopeKey, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(scopeKey)
    }
  }
}

export function useNativeChatReplyTarget(scopeKey: string): NativeChatReplyTarget | null {
  return useSyncExternalStore(
    (listener) => subscribe(scopeKey, listener),
    () => readNativeChatReplyTarget(scopeKey)
  )
}

/** Splits a sent reply back into the user's words and the reply it carried, so they can be edited again. */
export function nativeChatReplyTargetFromSentText(
  text: string,
  /** The chat it was sent in, whose record of the exact original it reads. */
  conversation: string
): {
  rest: string
  target: NativeChatReplyTarget | null
} {
  const quote = nativeChatReplyQuoteOf(text)
  if (!quote) {
    return { rest: text, target: null }
  }
  sequence += 1
  return {
    rest: quote.rest,
    target: {
      id: `${Date.now().toString(36)}-${sequence}`,
      // The original, when this client sent the reply; otherwise the transcript finds it by its words.
      messageId: nativeChatReplySourceOf(conversation, text) ?? '',
      author: quote.author,
      ...(quote.label ? { agentLabel: quote.label } : {}),
      excerpt: quote.excerpt
    }
  }
}

/** Test-only: forget all targets and reload from storage on next read. */
export function resetNativeChatReplyTargetsForTests(): void {
  targets.clear()
  custody.clear()
  custodyOwners.clear()
  ephemeral.clear()
  cancelled.clear()
  listeners.clear()
  loaded = false
}
