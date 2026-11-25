// One ledger, per picture owner, of what this window is doing to its picture: the choices made (a pick,
// an upload, a paste, a color or outfit, an undo), the saves and decodes still in flight, and the revisions those
// saves were acknowledged at. The owner is a bot (its `botRefKey`) or a dialog's bot not yet made. Every
// picture setting for a bot (the settings root, the panel header, the settings-wide paste) writes here,
// so a picture still being generated can tell whether it is still the latest thing asked for, and
// which revision to require when it is uploaded.

export type BotPictureEvent =
  | { kind: 'choice'; key: string }
  | { kind: 'ack'; key: string; revision: number }
  | { kind: 'failed'; key: string }
  | { kind: 'idle'; key: string }
  | { kind: 'automatic-settled'; key: string }

type Entry = { open: number; automatic: number }

const entries = new Map<string, Entry>()
const listeners = new Set<(event: BotPictureEvent) => void>()

function entryOf(key: string): Entry {
  let entry = entries.get(key)
  if (!entry) {
    entry = { open: 0, automatic: 0 }
    entries.set(key, entry)
  }
  return entry
}

function release(key: string): void {
  const entry = entries.get(key)
  if (entry && entry.open === 0 && entry.automatic === 0) {
    entries.delete(key)
  }
}

function emit(event: BotPictureEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

export function subscribeBotPictureEvents(listener: (event: BotPictureEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A picture, color or outfit choice for the owner: newer than anything asked for before it. */
export function noteBotPictureChoice(key: string): void {
  emit({ kind: 'choice', key })
}

/** A save or a decode in flight for the owner; `end` once it settles, either way. */
export function beginBotPictureOp(key: string): { end: () => void } {
  entryOf(key).open += 1
  let ended = false
  return {
    end: () => {
      if (ended) {
        return
      }
      ended = true
      const entry = entryOf(key)
      entry.open -= 1
      if (entry.open === 0) {
        release(key)
        emit({ kind: 'idle', key })
      }
    }
  }
}

export function botPictureOpsOpen(key: string): boolean {
  return (entries.get(key)?.open ?? 0) > 0
}

/** A save of the bot's picture, color or outfit was acknowledged at this revision (absent on an older host: 0). */
export function noteBotPictureAck(key: string, revision: number | undefined): void {
  emit({ kind: 'ack', key, revision: revision ?? 0 })
}

/** A save of the bot's picture, color or outfit was refused or failed: its revision is unknown. */
export function noteBotPictureFailure(key: string): void {
  emit({ kind: 'failed', key })
}

/** A save of the bot's picture, color or outfit settled: the bot it returned, or null when it failed. */
export function noteBotPictureSaved(key: string, saved: { avatarRevision?: number } | null): void {
  if (saved) {
    noteBotPictureAck(key, saved.avatarRevision)
  } else {
    noteBotPictureFailure(key)
  }
}

/** A generated picture's upload for the bot is in flight: a choice of the picture already saved is
 *  sent anyway, since the upload may land first. */
export function beginAutomaticBotPictureUpload(key: string): { end: () => void } {
  entryOf(key).automatic += 1
  let ended = false
  return {
    end: () => {
      if (ended) {
        return
      }
      ended = true
      entryOf(key).automatic -= 1
      release(key)
      emit({ kind: 'automatic-settled', key })
    }
  }
}

export function automaticBotPictureUploadInFlight(key: string): boolean {
  return (entries.get(key)?.automatic ?? 0) > 0
}
