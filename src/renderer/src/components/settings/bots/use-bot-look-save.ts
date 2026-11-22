import { useEffect, useRef, useState } from 'react'
import { DEFAULT_BOT_AVATAR_COLOR } from '../../../../../shared/bots/bot-avatar-color'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'
import { registerWindowCloseGuard } from '../../../app-shell/shutdown/window-close-request-coordinator'

export type BotLookUpdate = Pick<BotUpdateParams['updates'], 'avatarColor' | 'avatarOutfit'>

// Per bot: the save on its way to the host and the latest picks waiting behind it, merged. Every editor of a
// bot shares it, so a pick made after closing and reopening settings still lands last. Editors that are open
// hear when nothing is left to send; one that closes stops listening. While any are left, the host's re-read
// of its bots is held back, so each save returns as it lands and a later pick never waits on a re-read.
type LookSaves = {
  waiting: BotLookUpdate | null
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
// Closing or quitting waits a moment for picks on their way, so the app's last save before it goes has them.
const CLOSE_SAVE_WAIT_MS = 2000
// Closes waiting for every save to land; each removes itself at its deadline, so a hung save keeps none.
const idleWaiters = new Set<() => void>()
async function savePicksBeforeClose(): Promise<boolean> {
  for (const save of pausedPicks) {
    save()
  }
  if (lookSaves.size > 0) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        idleWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, CLOSE_SAVE_WAIT_MS)
      idleWaiters.add(done)
    })
  }
  return true
}
let listening = false
function sendOnLeave(): void {
  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener('pagehide', sendPicksOnLeave)
    registerWindowCloseGuard(savePicksBeforeClose)
  }
}

/** Saves `look` after any save already on its way; `onDrained` runs once nothing for this bot is left. */
export function saveBotLook(
  key: string,
  look: BotLookUpdate,
  update: (look: BotLookUpdate) => Promise<unknown>,
  onDrained?: () => void,
  hold?: BotLookHold
): void {
  const running = lookSaves.get(key)
  if (running) {
    running.waiting = { ...running.waiting, ...look }
    running.update = update
    if (onDrained) {
      running.drained.add(onDrained)
    }
    return
  }
  const saves: LookSaves = {
    waiting: look,
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
      // A failed save is reported by `update`; the picks after it still go.
      await saves.update(next).catch(() => undefined)
    }
    lookSaves.delete(key)
    if (lookSaves.size === 0) {
      for (const waiting of idleWaiters) {
        waiting()
      }
    }
    release?.()
    for (const listener of saves.drained) {
      listener()
    }
  })()
}

// Whether `change` is what the bot already shows (the default color stands for no color).
function shows(saved: BotLookUpdate, change: BotLookUpdate): boolean {
  return (
    (!('avatarColor' in change) ||
      (change.avatarColor ?? DEFAULT_BOT_AVATAR_COLOR) ===
        (saved.avatarColor ?? DEFAULT_BOT_AVATAR_COLOR)) &&
    (!('avatarOutfit' in change) || (change.avatarOutfit ?? null) === (saved.avatarOutfit ?? null))
  )
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
  /** The bot's look as saved: a pick of it, with nothing else picked or saving, sends nothing. */
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
  const pick = (change: BotLookUpdate): void => {
    if (!timer.current && !lookSaves.has(key) && shows(saved, change)) {
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
      saveBotLook(key, look, update, open.current ? drained.current : undefined, hold)
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
