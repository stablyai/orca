import { useCallback, useEffect, useMemo, useState } from 'react'

export type NativeChatMcpTrayState = {
  isOpen: boolean
  /** Counts `/mcp` runs, so running it on an open tray re-reads the servers. */
  opens: number
  open: () => void
  close: () => void
}

/** Whether `/mcp`'s tray is open on this chat; another chat, or leaving this one, closes it. */
export function useNativeChatMcpTray(
  sessionId: string,
  isVisible: boolean
): NativeChatMcpTrayState {
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [opens, setOpens] = useState(0)
  const open = useCallback(() => {
    setOpenFor(sessionId)
    setOpens((count) => count + 1)
  }, [sessionId])
  const close = useCallback(() => setOpenFor(null), [])
  // Hiding the pane (switching tabs) closes it; the tray isn't there to come back to.
  useEffect(() => {
    if (!isVisible) {
      return
    }
    return () => setOpenFor(null)
  }, [isVisible])
  const isOpen = isVisible && openFor === sessionId
  return useMemo(() => ({ isOpen, opens, open, close }), [isOpen, opens, open, close])
}
