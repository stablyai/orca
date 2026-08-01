import { useEffect, useState } from 'react'

// Why: no push channel for subscriber changes yet, so poll while the panel is open (mirrors PeerCollabSettingsPane's connected-clients poll).
const SUBSCRIBERS_POLL_MS = 4000

/** Names of the other peer clients currently watching this same host terminal. Pauses while `hidden` (keep-alive backgrounded panel). */
export function usePeerTerminalSubscribers(
  hostId: string,
  terminalHandle: string,
  hidden = false
): string[] {
  const [otherSubscribers, setOtherSubscribers] = useState<string[]>([])

  useEffect(() => {
    if (hidden) {
      return
    }
    setOtherSubscribers([])
    let disposed = false
    const poll = async (): Promise<void> => {
      const result = await window.api.peerClient.listTerminalSubscribers({
        hostId,
        terminal: terminalHandle
      })
      if (disposed) {
        return
      }
      setOtherSubscribers(result.ok ? result.subscribers.map((s) => s.name) : [])
    }
    void poll()
    const timer = window.setInterval(() => void poll(), SUBSCRIBERS_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [hostId, terminalHandle, hidden])

  return otherSubscribers
}
