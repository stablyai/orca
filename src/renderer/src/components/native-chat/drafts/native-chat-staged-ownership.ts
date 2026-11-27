// Which draft holds which staged original can change on any staging edit. Whoever shows that (a
// held-elsewhere notice) listens while it is shown, and hears once per task however many edits there
// were; with nobody listening an edit only bumps a number.

let ownershipVersion = 0
let ownershipNotice: Promise<void> | null = null
const ownershipListeners = new Set<() => void>()

/** A staging edit that can change which draft holds an original. */
export function nativeChatStagedOwnershipChanged(): void {
  ownershipVersion += 1
  if (ownershipListeners.size === 0 || ownershipNotice) {
    return
  }
  ownershipNotice = Promise.resolve().then(() => {
    ownershipNotice = null
    for (const listener of Array.from(ownershipListeners)) {
      listener()
    }
  })
}

export function nativeChatStagedOwnershipVersion(): number {
  return ownershipVersion
}

export function subscribeToNativeChatStagedOwnership(listener: () => void): () => void {
  ownershipListeners.add(listener)
  return () => {
    ownershipListeners.delete(listener)
  }
}
