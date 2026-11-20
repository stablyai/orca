import { useEffect, useRef, useState } from 'react'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'

export type BotLookUpdate = Pick<BotUpdateParams['updates'], 'avatarColor' | 'avatarOutfit'>

// Per bot: the save on its way to the host and the latest picks waiting behind it, merged. Every editor of a
// bot shares it, so a pick made after closing and reopening settings still lands last. Editors that are open
// hear when nothing is left to send; one that closes stops listening.
type LookSaves = {
  waiting: BotLookUpdate | null
  update: (look: BotLookUpdate) => Promise<unknown>
  drained: Set<() => void>
}

const lookSaves = new Map<string, LookSaves>()

/** Saves `look` after any save already on its way; `onDrained` runs once nothing for this bot is left. */
export function saveBotLook(
  key: string,
  look: BotLookUpdate,
  update: (look: BotLookUpdate) => Promise<unknown>,
  onDrained?: () => void
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
  void (async () => {
    while (saves.waiting) {
      const next = saves.waiting
      saves.waiting = null
      // A failed save is reported by `update`; the picks after it still go.
      await saves.update(next).catch(() => undefined)
    }
    lookSaves.delete(key)
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
  delayMs: number
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
    const look = { ...timer.current?.look, ...change }
    setPicked((shown) => ({ ...shown, ...change }))
    if (timer.current) {
      clearTimeout(timer.current.timer)
    }
    const save = (): void => {
      timer.current = null
      saveBotLook(key, look, update, open.current ? drained.current : undefined)
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
