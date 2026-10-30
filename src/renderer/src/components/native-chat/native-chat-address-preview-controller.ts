import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  CHAT_ADDRESS_PREVIEW_CLIENT_ERROR,
  CHAT_ADDRESS_PREVIEW_LIMIT,
  type ChatAddressPreviewEntry,
  type ChatAddressPreviewRequest,
  type ChatAddressPreviewResult
} from '../../../../shared/chat-address-preview'
import { draftContainsAddress, pastedAddressCandidates } from './native-chat-address-candidates'

export type AddressPreviewTransport = {
  open: (request: ChatAddressPreviewRequest) => Promise<ChatAddressPreviewResult>
  release: (id: string) => Promise<void>
}

/** Owns only previews admitted by a paste, never attachment delivery or draft text. */
export function createAddressPreviewController(
  transport: AddressPreviewTransport,
  readDraft: () => string
) {
  let active = false
  let entries: readonly ChatAddressPreviewEntry[] = []
  const listeners = new Set<() => void>()
  const pending = new Map<string, symbol>()
  const publish = (next: readonly ChatAddressPreviewEntry[]): void => {
    entries = next
    for (const notify of listeners) {
      notify()
    }
  }
  const release = (id: string): void => {
    pending.delete(id)
    // Teardown must not turn a closed composer into an unhandled rejection.
    void transport.release(id).catch(() => {})
  }
  const dismiss = (id: string): void => {
    release(id)
    publish(entries.filter((entry) => entry.id !== id))
  }
  const load = (entry: ChatAddressPreviewEntry, allowPrivateNetwork = false): void => {
    const attempt = Symbol()
    pending.set(entry.id, attempt)
    void transport
      .open({ id: entry.id, source: entry.source, allowPrivateNetwork })
      .catch((): ChatAddressPreviewResult => ({
        status: 'error',
        id: entry.id,
        message: CHAT_ADDRESS_PREVIEW_CLIENT_ERROR.unavailable
      }))
      .then((result) => {
        if (!active || pending.get(entry.id) !== attempt) {
          // Retry uses a new ID, so this cannot release the replacement resource.
          release(entry.id)
          return
        }
        if (!draftContainsAddress(readDraft(), entry.source)) {
          dismiss(entry.id)
          return
        }
        pending.delete(entry.id)
        publish(
          entries.map((current) => (current.id === entry.id ? { ...current, result } : current))
        )
      })
  }
  const retry = (id: string, allowPrivateNetwork = false): void => {
    const previous = entries.find((entry) => entry.id === id)
    if (!active || !previous) {
      return
    }
    if (!draftContainsAddress(readDraft(), previous.source)) {
      dismiss(id)
      return
    }
    release(id)
    const replacement = { id: createBrowserUuid(), source: previous.source, result: null }
    publish(entries.map((entry) => (entry.id === id ? replacement : entry)))
    load(replacement, allowPrivateNetwork)
  }
  return {
    getSnapshot: () => entries,
    subscribe(notify: () => void) {
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    activate() {
      active = true
    },
    dispose() {
      active = false
      for (const entry of entries) {
        release(entry.id)
      }
      publish([])
    },
    pasted(text: string) {
      if (!active) {
        return
      }
      const draft = readDraft()
      const additions: ChatAddressPreviewEntry[] = []
      for (const source of pastedAddressCandidates(text)) {
        if (entries.length + additions.length >= CHAT_ADDRESS_PREVIEW_LIMIT) {
          break
        }
        if (
          entries.some((entry) => entry.source === source) ||
          !draftContainsAddress(draft, source)
        ) {
          continue
        }
        additions.push({ id: createBrowserUuid(), source, result: null })
      }
      if (additions.length === 0) {
        return
      }
      publish([...entries, ...additions])
      for (const entry of additions) {
        load(entry)
      }
    },
    reconcile(draft: string) {
      const removed = entries.filter((entry) => !draftContainsAddress(draft, entry.source))
      if (removed.length === 0) {
        return
      }
      for (const entry of removed) {
        release(entry.id)
      }
      publish(entries.filter((entry) => !removed.includes(entry)))
    },
    dismiss,
    retry
  }
}
