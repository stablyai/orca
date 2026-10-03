// One chat's unsent composer content as it is saved: by the main process on desktop, in browser
// storage in the web client. Parsed the same way in both, so a damaged record is dropped, not trusted.

import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

/**
 * Where an image's file lives: on this machine, on an SSH host (`connectionId`), or on a runtime
 * server. Chips saved before this was recorded have none, and are treated as unknown.
 */
export type NativeChatDraftAttachmentLocation = 'local' | 'ssh' | 'runtime'

export type NativeChatDraftAttachment = {
  id: string
  path: string
  connectionId?: string
  location?: NativeChatDraftAttachmentLocation
}

/** Launch text Orca typed into a terminal agent's input line, which still holds it. */
export type NativeChatTuiInputSeed = { agent: TuiAgent; text: string; createdAt: number }

/**
 * A message sent from this box that the host may not hold yet: kept beside the live draft from
 * Enter until the host holds it, so a crash in between can still give it back. After a relaunch it
 * goes back into the box unless the host holds it by then.
 */
export type NativeChatHeldSend = {
  /** The send's id, which the host's submission or queued card carries. */
  clientMessageId: string
  text: string
  attachments: readonly NativeChatDraftAttachment[]
  /** When it was sent. */
  sentAt: number
}

export type PersistedNativeChatDraft = {
  text: string
  attachments: readonly NativeChatDraftAttachment[]
  tuiInputSeed?: NativeChatTuiInputSeed
  /** Outbox entries already moved into this draft, so a crash before the outbox drops them never
   *  imports them twice. Kept as read; written by the outbox importer. */
  importedOutboxEntryIds?: readonly string[]
  /** Sends from this box the host may not hold yet, oldest first. */
  heldSends?: readonly NativeChatHeldSend[]
}

/** One saved draft and the chat it belongs to. */
export type SavedNativeChatDraft = { scopeKey: string; draft: PersistedNativeChatDraft }

/**
 * The outcome of a write; `failed` and `unavailable` leave the draft in memory only. `unavailable`
 * means there is no storage to write to (a browser with site storage blocked), not an error.
 */
export type NativeChatDraftStoreResult = 'persisted' | 'failed' | 'unavailable'

export function isEmptyNativeChatDraft(draft: PersistedNativeChatDraft): boolean {
  return (
    draft.text === '' &&
    draft.attachments.length === 0 &&
    !draft.tuiInputSeed &&
    !draft.importedOutboxEntryIds?.length &&
    !draft.heldSends?.length
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const ATTACHMENT_LOCATIONS: readonly unknown[] = ['local', 'ssh', 'runtime']

function isAttachmentLocation(value: unknown): value is NativeChatDraftAttachmentLocation {
  return ATTACHMENT_LOCATIONS.includes(value)
}

function parseAttachment(value: unknown): NativeChatDraftAttachment | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, path, connectionId, location } = value
  if (typeof id !== 'string' || typeof path !== 'string' || path === '') {
    return null
  }
  return {
    id,
    path,
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(isAttachmentLocation(location) ? { location } : {})
  }
}

function parseTuiInputSeed(value: unknown): { tuiInputSeed?: NativeChatTuiInputSeed } {
  if (!isRecord(value)) {
    return {}
  }
  const { agent, text, createdAt } = value
  return isTuiAgent(agent) &&
    typeof text === 'string' &&
    text !== '' &&
    typeof createdAt === 'number'
    ? { tuiInputSeed: { agent, text, createdAt } }
    : {}
}

function parseAttachments(value: unknown[]): NativeChatDraftAttachment[] {
  return value
    .map(parseAttachment)
    .filter((attachment): attachment is NativeChatDraftAttachment => attachment !== null)
}

// Fields a newer build adds are ignored; an entry missing its id or text is dropped.
function parseHeldSends(value: unknown): { heldSends?: NativeChatHeldSend[] } {
  if (!Array.isArray(value)) {
    return {}
  }
  const heldSends = value.flatMap((entry): NativeChatHeldSend[] => {
    if (!isRecord(entry)) {
      return []
    }
    const { clientMessageId, text, attachments, sentAt } = entry
    if (typeof clientMessageId !== 'string' || clientMessageId === '' || typeof text !== 'string') {
      return []
    }
    return [
      {
        clientMessageId,
        text,
        attachments: Array.isArray(attachments) ? parseAttachments(attachments) : [],
        sentAt: typeof sentAt === 'number' ? sentAt : 0
      }
    ]
  })
  return heldSends.length > 0 ? { heldSends } : {}
}

function parseImportedOutboxEntryIds(value: unknown): { importedOutboxEntryIds?: string[] } {
  if (!Array.isArray(value)) {
    return {}
  }
  const ids = value.filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? { importedOutboxEntryIds: ids } : {}
}

/** A saved draft from untrusted bytes; null when unreadable or empty. */
export function parseNativeChatDraft(value: unknown): PersistedNativeChatDraft | null {
  if (!isRecord(value)) {
    return null
  }
  const { text, attachments, tuiInputSeed, importedOutboxEntryIds, heldSends } = value
  if (typeof text !== 'string' || !Array.isArray(attachments)) {
    return null
  }
  const draft = {
    text,
    attachments: parseAttachments(attachments),
    ...parseTuiInputSeed(tuiInputSeed),
    ...parseImportedOutboxEntryIds(importedOutboxEntryIds),
    ...parseHeldSends(heldSends)
  }
  return isEmptyNativeChatDraft(draft) ? null : draft
}
