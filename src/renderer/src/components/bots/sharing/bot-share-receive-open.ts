// A shared bot link to receive: from `orca://bots/share/<id>`, or pasted in New bot → From a link.
import { useSyncExternalStore } from 'react'

/** A link to review, or `paste` to ask for one; `key` remounts the flow when the same link opens again. */
export type BotShareReceiveRequest = { shareId: string | null; key: number }

let request: BotShareReceiveRequest | null = null
let opened = 0
const listeners = new Set<() => void>()

function publish(next: BotShareReceiveRequest | null): void {
  request = next
  for (const listener of listeners) {
    listener()
  }
}

/** Opens a link's review; null asks for a link first. */
export function openBotShareLink(shareId: string | null): void {
  opened += 1
  publish({ shareId, key: opened })
}

export function closeBotShareLink(): void {
  publish(null)
}

export function useBotShareReceiveRequest(): BotShareReceiveRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => request
  )
}
