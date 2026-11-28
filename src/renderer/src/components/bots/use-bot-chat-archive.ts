// This profile's archived bot chats, shared by every row and by other windows of the same profile.
import { useSyncExternalStore } from 'react'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import {
  botChatArchiveOrEmpty,
  withBotChatArchive,
  type BotChatArchive
} from '../../../../shared/bots/bot-chat-archive'

const STORAGE_KEY = 'orca.bot-chat-archive.v1'

let archive: BotChatArchive | null = null
const listeners = new Set<() => void>()

function sameArchive(a: BotChatArchive, b: BotChatArchive): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
}

/** Storage now; null only when storage itself can't be read. Malformed data fails open. */
function readStorage(): BotChatArchive | null {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) {
    return {}
  }
  try {
    return botChatArchiveOrEmpty(JSON.parse(raw))
  } catch {
    return {}
  }
}

function currentArchive(): BotChatArchive {
  archive ??= readStorage() ?? {}
  return archive
}

function publish(next: BotChatArchive): void {
  if (sameArchive(currentArchive(), next)) {
    return
  }
  archive = next
  listeners.forEach((listener) => listener())
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) {
    return
  }
  const stored = readStorage()
  if (stored !== null) {
    publish(stored)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener('storage', onStorage)
    const stored = readStorage()
    if (stored !== null) {
      publish(stored)
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener('storage', onStorage)
      archive = null
    }
  }
}

/** The archive map's identity changes only when a watermark does. */
export function useBotChatArchive(): BotChatArchive {
  return useSyncExternalStore(subscribe, currentArchive)
}

export function setBotChatArchived(
  hostId: string,
  botId: string,
  chat: BotChatTreeChat,
  archived: boolean
): void {
  const base = readStorage() ?? currentArchive()
  const next = withBotChatArchive(base, hostId, botId, chat, archived)
  if (next === base) {
    return
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {}
  publish(next)
}
