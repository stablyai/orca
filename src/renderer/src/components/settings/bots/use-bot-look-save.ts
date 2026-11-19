import { useRef, useState } from 'react'
import type { BotUpdateParams } from '../../../../../shared/rpc-contract/bots-params'

export type BotLookUpdate = Pick<BotUpdateParams['updates'], 'avatarColor' | 'avatarOutfit'>

/**
 * The tile color and outfit save on their own, the latest picks after a pause, one save at a time so the host
 * gets them in the order they were made; until they land they show as picked.
 */
export function useBotLookSave(
  update: (look: BotLookUpdate) => Promise<unknown>,
  delayMs: number
): { picked: BotLookUpdate | null; pick: (change: BotLookUpdate) => void; flush: () => void } {
  const [picked, setPicked] = useState<BotLookUpdate | null>(null)
  const timer = useRef<{
    timer: ReturnType<typeof setTimeout>
    save: () => void
    look: BotLookUpdate
  } | null>(null)
  const latestPick = useRef(0)
  const saves = useRef<Promise<unknown>>(Promise.resolve())
  const pick = (change: BotLookUpdate): void => {
    const look = { ...timer.current?.look, ...change }
    const thisPick = (latestPick.current += 1)
    setPicked((shown) => ({ ...shown, ...change }))
    if (timer.current) {
      clearTimeout(timer.current.timer)
    }
    const save = (): void => {
      timer.current = null
      const saved = saves.current.then(() => update(look))
      saves.current = saved.catch(() => undefined)
      void saved.finally(() => {
        // Shown as saved once it lands, unless something newer was picked meanwhile.
        if (latestPick.current === thisPick) {
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
