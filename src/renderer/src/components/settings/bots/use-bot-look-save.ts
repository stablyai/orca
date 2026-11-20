import { useRef, useState } from 'react'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'

export type BotLookUpdate = Pick<BotUpdateParams['updates'], 'avatarColor' | 'avatarOutfit'>

// Per bot: the save on its way to the host and the latest picks waiting behind it, merged. Every editor of a
// bot shares it, so a pick made after closing and reopening settings still lands last.
type LookSaves = {
  waiting: BotLookUpdate | null
  update: (look: BotLookUpdate) => Promise<unknown>
  drained: Promise<void>
}

const lookSaves = new Map<string, LookSaves>()

/** Saves `look` after any save already on its way; resolves once nothing for this bot is left to send. */
export function saveBotLook(
  key: string,
  look: BotLookUpdate,
  update: (look: BotLookUpdate) => Promise<unknown>
): Promise<void> {
  const running = lookSaves.get(key)
  if (running) {
    running.waiting = { ...running.waiting, ...look }
    running.update = update
    return running.drained
  }
  const saves: LookSaves = { waiting: look, update, drained: Promise.resolve() }
  saves.drained = (async () => {
    while (saves.waiting) {
      const next = saves.waiting
      saves.waiting = null
      // A failed save is reported by `update`; the picks after it still go.
      await saves.update(next).catch(() => undefined)
    }
    lookSaves.delete(key)
  })()
  lookSaves.set(key, saves)
  return saves.drained
}

/**
 * The tile color and outfit save on their own, the latest picks after a pause, one save at a time so the host
 * gets them in the order they were made; until they land they show as picked.
 */
export function useBotLookSave(
  key: string,
  update: (look: BotLookUpdate) => Promise<unknown>,
  delayMs: number
): { picked: BotLookUpdate | null; pick: (change: BotLookUpdate) => void; flush: () => void } {
  const [picked, setPicked] = useState<BotLookUpdate | null>(null)
  const timer = useRef<{
    timer: ReturnType<typeof setTimeout>
    save: () => void
    look: BotLookUpdate
  } | null>(null)
  // The drain this editor waits on, so it observes each one once however many picks join it.
  const watched = useRef<Promise<void> | null>(null)
  const pick = (change: BotLookUpdate): void => {
    const look = { ...timer.current?.look, ...change }
    setPicked((shown) => ({ ...shown, ...change }))
    if (timer.current) {
      clearTimeout(timer.current.timer)
    }
    const save = (): void => {
      timer.current = null
      const drained = saveBotLook(key, look, update)
      if (watched.current === drained) {
        return
      }
      watched.current = drained
      void drained.then(() => {
        watched.current = null
        // Shown as saved once everything picked has landed, unless a newer pick is still waiting.
        if (!timer.current) {
          setPicked(null)
        }
      })
    }
    timer.current = { timer: setTimeout(save, delayMs), save, look }
  }
  const flush = (): void => {
    if (timer.current) {
      clearTimeout(timer.current.timer)
      timer.current.save()
    }
  }
  return { picked, pick, flush }
}
