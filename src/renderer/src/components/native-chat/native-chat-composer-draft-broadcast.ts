import { foreignReads } from './native-chat-composer-draft-write-operations'
import {
  hasLocalChange,
  records,
  isNativeChatSetupDraft,
  reconcileRestoredImageChecks,
  installNativeChatDraftRecord,
  notifyScope
} from './native-chat-composer-draft-memory'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const CHANNEL_NAME = 'orca-native-chat-composer-drafts'
let channel: BroadcastChannel | null = null

function adoptForeignChange(message: unknown): void {
  const scopeKey =
    typeof message === 'object' && message !== null && 'scopeKey' in message
      ? message.scopeKey
      : null
  if (typeof scopeKey !== 'string' || hasLocalChange(scopeKey)) {
    return
  }
  const read = {}
  foreignReads.set(scopeKey, read)
  const before = records.get(scopeKey)
  void nativeChatComposerDraftStorage()
    .read(scopeKey)
    .then((value) => {
      if (
        foreignReads.get(scopeKey) !== read ||
        records.get(scopeKey) !== before ||
        hasLocalChange(scopeKey)
      ) {
        return
      }
      if (isNativeChatSetupDraft(scopeKey) && value != null) {
        return
      }
      foreignReads.delete(scopeKey)
      const draft = parseStoredNativeChatComposerDraft(value)
      if (draft) {
        reconcileRestoredImageChecks(scopeKey, draft.images, records.get(scopeKey)?.images ?? [])
        installNativeChatDraftRecord(scopeKey, draft)
      } else {
        installNativeChatDraftRecord(scopeKey)
        reconcileRestoredImageChecks(scopeKey, [])
      }
      notifyScope(scopeKey)
    })
    .catch(() => {})
    .finally(() => {
      if (foreignReads.get(scopeKey) === read) {
        foreignReads.delete(scopeKey)
      }
    })
}

export function installNativeChatComposerDraftBroadcast(): void {
  if (channel || typeof BroadcastChannel === 'undefined') {
    return
  }
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event) => adoptForeignChange(event.data)
  // Why: Node's channel (unit tests) would otherwise keep the process alive.
  if ('unref' in channel && typeof channel.unref === 'function') {
    channel.unref()
  }
}

export function broadcastNativeChatComposerDraftChange(scopeKey: string): void {
  channel?.postMessage({ scopeKey })
}

export function resetNativeChatComposerDraftBroadcast(): void {
  channel?.close()
  channel = null
}
