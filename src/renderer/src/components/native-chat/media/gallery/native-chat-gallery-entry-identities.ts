import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import type { NativeChatGalleryEntry } from './native-chat-gallery-entries'
import { nativeChatGalleryEntryKey } from './native-chat-gallery-entries'

type Identity = { key: string; users: number }

/** Full-field comparison stays on the worker; renderer identities have fixed-size components. */
export class NativeChatGalleryEntryIdentities {
  private readonly prefix = createNonSecureContextUuid()
  private sequence = 0
  private readonly identities = new Map<string, Identity>()
  private readonly restoredKeys = new Set<string>()

  restore(entries: readonly NativeChatGalleryEntry[]): void {
    for (const entry of entries) {
      this.restoredKeys.add(entry.key)
      this.identities.set(nativeChatGalleryEntryKey(entry), { key: entry.key, users: 0 })
    }
  }

  discardUnused(): void {
    for (const [key, identity] of this.identities) {
      if (identity.users === 0) {
        this.identities.delete(key)
      }
    }
  }

  retain(entry: NativeChatGalleryEntry): NativeChatGalleryEntry {
    let identity = this.identities.get(entry.key)
    if (!identity) {
      let key: string
      do {
        if (!Number.isSafeInteger(++this.sequence)) {
          throw new Error('Gallery identity space was exhausted')
        }
        key = `${this.prefix}:${this.sequence}`
      } while (this.restoredKeys.has(key))
      identity = { key, users: 0 }
      this.identities.set(entry.key, identity)
    }
    identity.users++
    return { ...entry, key: identity.key }
  }

  release(keys: readonly string[]): void {
    for (const key of keys) {
      const identity = this.identities.get(key)
      if (identity && --identity.users === 0) {
        this.identities.delete(key)
      }
    }
  }

  clear(): void {
    this.identities.clear()
    this.restoredKeys.clear()
  }
}
