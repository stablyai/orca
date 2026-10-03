import type { NativeChatDraftsApi } from '../../../../preload/api-types'
import type { NativeChatDraftStoreResult } from '../../../../shared/native-chat-draft-record'
import { createWebNativeChatDrafts } from '../../web/preload-api/web-native-chat-drafts'

/** Puts `drafts` on `window.api.nativeChat`, keeping whatever else the test installed. */
export function installNativeChatDrafts(drafts: NativeChatDraftsApi): void {
  const api: Record<string, unknown> = { ...window.api }
  const nativeChat: Record<string, unknown> = { ...window.api?.nativeChat }
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { ...api, nativeChat: { ...nativeChat, drafts } }
  })
}

/**
 * Saves drafts in localStorage, as the web client does, so a test can read them back. Starts
 * empty: drafts an earlier test saved are removed. `like: 'desktop'` saves a send's clear once
 * the host has the message, as the desktop store does.
 */
export function installLocalStorageNativeChatDrafts(
  options: { like?: 'web' | 'desktop' } = {}
): NativeChatDraftsApi {
  const { savesSendClearAtOnce: _web, ...desktop } = createWebNativeChatDrafts()
  const drafts = options.like === 'desktop' ? desktop : createWebNativeChatDrafts()
  for (const { scopeKey } of drafts.loadSync()) {
    // Settles synchronously: browser storage has no async step.
    void drafts.write(scopeKey, null)
  }
  installNativeChatDrafts(drafts)
  return drafts
}

export type HeldNativeChatDraftWrite = {
  scopeKey: string
  draft: unknown
  settle: (result: NativeChatDraftStoreResult) => void
}

/** A store whose writes stay unconfirmed until the test settles them, as a slow disk would. */
export function installHeldNativeChatDrafts(): HeldNativeChatDraftWrite[] {
  const writes: HeldNativeChatDraftWrite[] = []
  installNativeChatDrafts({
    load: async () => [],
    loadSync: () => [],
    write: (scopeKey, draft) =>
      new Promise((resolve) => writes.push({ scopeKey, draft, settle: resolve }))
  })
  return writes
}
