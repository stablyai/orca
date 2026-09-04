import { useEffect, useState } from 'react'
import { INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS } from './inline-setup-terminal-stall'

export function useInlineSetupTerminalStall(active: boolean): boolean {
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (!active) {
      setStalled(false)
      return
    }
    const timer = window.setTimeout(() => setStalled(true), INLINE_SETUP_TERMINAL_STALL_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [active])

  return stalled
}
