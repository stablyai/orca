import { useEffect, useRef, useState } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { DEFAULT_BOT_AVATAR_COLOR } from '../../../../../shared/bots/bot-avatar-color'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'

export type BotLookUpdate = Pick<BotUpdateParams['updates'], 'avatarColor' | 'avatarOutfit'>

// Per bot: the save on its way to the host and the latest picks waiting behind it, merged. Every editor of a
// bot shares it, so a pick made after closing and reopening settings still lands last. Editors that are open
// hear when nothing is left to send; one that closes stops listening. While any are left, the host's re-read
// of its bots is held back, so each save returns as it lands and a later pick never waits on a re-read.
type LookSaves = {
  /** The bot's look once the save on its way lands; a pick of it sends nothing. */
  landing: BotLookUpdate
  waiting: BotLookUpdate | null
  /** Picks of the look on its way, sent again if that save fails. */
  repeated: BotLookUpdate | null
  update: (look: BotLookUpdate) => Promise<unknown>
  drained: Set<() => void>
}

/** Holds the host's re-read back until the returned release runs. */
export type BotLookHold = () => () => unknown

const lookSaves = new Map<string, LookSaves>()

// Picks still in their pause before saving, each as the save that ends the pause early.
const pausedPicks = new Set<() => void>()

// The window can't wait for a save on its way when it goes, so paused picks and the picks waiting behind
// a save go at once, as each pick did before they queued; left, they would be lost on quit or reload.
function sendPicksOnLeave(): void {
  for (const save of pausedPicks) {
    save()
  }
  for (const saves of lookSaves.values()) {
    const next = saves.waiting
    if (next) {
      saves.waiting = null
      void saves.update(next).catch(() => undefined)
    }
  }
}
let listening = false
function sendOnLeave(): void {
  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener('pagehide', sendPicksOnLeave)
  }
}

const sameValue = {
  avatarColor: (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? DEFAULT_BOT_AVATAR_COLOR) === (b ?? DEFAULT_BOT_AVATAR_COLOR),
  avatarOutfit: (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? null) === (b ?? null)
}

type LookField = keyof typeof sameValue
const LOOK_FIELDS: readonly LookField[] = ['avatarColor', 'avatarOutfit']

// Per bot, the fields whose last save failed: the host may not hold what the bot shows, so a pick of them sends.
const unsure = new Map<string, Set<LookField>>()

function only(look: BotLookUpdate, fields: readonly LookField[]): BotLookUpdate | null {
  return fields.length > 0 ? Object.fromEntries(fields.map((field) => [field, look[field]])) : null
}

// The fields of `look` that would change the bot from `landing`, or null when none would.
function changes(key: string, look: BotLookUpdate, landing: BotLookUpdate): BotLookUpdate | null {
  return only(
    look,
    LOOK_FIELDS.filter(
      (field) =>
        field in look &&
        (unsure.get(key)?.has(field) || !sameValue[field](look[field], landing[field]))
    )
  )
}

// The fields of `look` the bot already shows or has on its way.
function repeats(key: string, look: BotLookUpdate, landing: BotLookUpdate): BotLookUpdate | null {
  const changed = changes(key, look, landing) ?? {}
  return only(
    look,
    LOOK_FIELDS.filter((field) => field in look && !(field in changed))
  )
}

/** Saves `look` after any save already on its way; `onDrained` runs once nothing for this bot is left.
 *  `saved` is the bot's look as shown, so a look that changes nothing sends nothing. */
export function saveBotLook(
  key: string,
  look: BotLookUpdate,
  update: (look: BotLookUpdate) => Promise<unknown>,
  onDrained?: () => void,
  hold?: BotLookHold,
  saved: BotLookUpdate = {}
): void {
  const running = lookSaves.get(key)
  if (running) {
    const merged = { ...running.waiting, ...look }
    running.waiting = changes(key, merged, running.landing)
    const repeated = { ...running.repeated, ...repeats(key, look, running.landing) }
    running.repeated = Object.keys(repeated).length > 0 ? repeated : null
    running.update = update
    if (onDrained) {
      running.drained.add(onDrained)
    }
    return
  }
  const first = changes(key, look, saved)
  if (!first) {
    onDrained?.()
    return
  }
  const saves: LookSaves = {
    landing: { avatarColor: saved.avatarColor, avatarOutfit: saved.avatarOutfit },
    waiting: first,
    repeated: null,
    update,
    drained: new Set(onDrained ? [onDrained] : [])
  }
  lookSaves.set(key, saves)
  sendOnLeave()
  const release = hold?.()
  void (async () => {
    while (saves.waiting) {
      const next = saves.waiting
      saves.waiting = null
      saves.landing = { ...saves.landing, ...next }
      saves.repeated = null
      // A failed save is reported by `update` (which then gives null); the picks after it still go.
      const result = await saves.update(next).catch(() => null)
      const sent = LOOK_FIELDS.filter((field) => field in next)
      const fields = unsure.get(key) ?? new Set<LookField>()
      for (const field of sent) {
        if (result === null) {
          fields.add(field)
        } else {
          fields.delete(field)
        }
      }
      if (fields.size > 0) {
        unsure.set(key, fields)
      } else {
        unsure.delete(key)
      }
      if (result === null && saves.repeated) {
        saves.waiting = { ...saves.repeated, ...saves.waiting }
      }
    }
    lookSaves.delete(key)
    release?.()
    for (const listener of saves.drained) {
      listener()
    }
  })()
}

/**
 * The tile color and outfit save on their own, the latest picks after a pause, one save at a time so the host
 * gets them in the order they were made; until they land they show as picked.
 */
export function useBotLookSave(
  key: string,
  update: (look: BotLookUpdate) => Promise<unknown>,
  delayMs: number,
  hold?: BotLookHold,
  /** The bot's look as shown, so a save that changes nothing sends nothing. */
  saved: BotLookUpdate = {}
): { picked: BotLookUpdate | null; pick: (change: BotLookUpdate) => void; flush: () => void } {
  const [picked, setPicked] = useState<BotLookUpdate | null>(null)
  const timer = useRef<{
    timer: ReturnType<typeof setTimeout>
    save: () => void
    look: BotLookUpdate
  } | null>(null)
  // One listener per editor, however many of its picks join a drain.
  const drained = useRef(() => {
    // Shown as saved once everything picked has landed, unless a newer pick is still waiting.
    if (!timer.current) {
      setPicked(null)
    }
  })
  // A closed editor's last pick still saves (the close flush), with no one left to hear it land.
  const open = useRef(true)
  useEffect(() => {
    const listener = drained.current
    open.current = true
    return () => {
      open.current = false
      lookSaves.get(key)?.drained.delete(listener)
    }
  }, [key])
  // Read when the pause ends, so it is the look shown then.
  const savedLook = useLatestHandler(() => saved)
  const pick = (change: BotLookUpdate): void => {
    // A pick of what this editor shows changes nothing here, so it neither renders nor delays this editor's
    // earlier pick; it goes straight to the bot's queue, where it may still cancel a pick waiting there.
    if (!changes(key, change, { ...savedLook(), ...picked })) {
      saveBotLook(key, change, update, undefined, hold, savedLook())
      return
    }
    const look = { ...timer.current?.look, ...change }
    setPicked((shown) => ({ ...shown, ...change }))
    if (timer.current) {
      clearTimeout(timer.current.timer)
      pausedPicks.delete(timer.current.save)
    }
    const save = (): void => {
      if (timer.current?.save === save) {
        clearTimeout(timer.current.timer)
        timer.current = null
      }
      pausedPicks.delete(save)
      saveBotLook(key, look, update, open.current ? drained.current : undefined, hold, savedLook())
    }
    timer.current = { timer: setTimeout(save, delayMs), save, look }
    pausedPicks.add(save)
    sendOnLeave()
  }
  const flush = (): void => {
    timer.current?.save()
  }
  return { picked, pick, flush }
}
