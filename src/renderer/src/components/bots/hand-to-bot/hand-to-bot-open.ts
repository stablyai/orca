// The workspace Hand to bot is open for, from its card's menu; the flow is mounted once, outside the card,
// so it outlives the card leaving Projects when the workspace moves under the bot.
import { useSyncExternalStore } from 'react'
import type { Worktree } from '../../../../../shared/worktree/types'

/** The clicked row itself, since a workspace id can repeat across computers; `key` remounts the flow
 *  when the same workspace is handed again. */
export type HandToBotRequest = { worktree: Worktree; key: number }

let request: HandToBotRequest | null = null
let opened = 0
const listeners = new Set<() => void>()

function publish(next: HandToBotRequest | null): void {
  request = next
  for (const listener of listeners) {
    listener()
  }
}

export function openHandToBot(worktree: Worktree): void {
  opened += 1
  publish({ worktree, key: opened })
}

export function closeHandToBot(): void {
  publish(null)
}

export function useHandToBotRequest(): HandToBotRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => request
  )
}
