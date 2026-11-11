import { useCallback, useEffect, useState } from 'react'

/**
 * When setup finishes (RR-b, team-lead + design-squad):
 * - Visible page: "All set" holds for `settleMs`, then the workspace starts (Start was already
 *   pressed once; a second click adds friction, not consent).
 * - Hidden page (under another view or workspace): never auto-start, so no sandbox appears the user
 *   can't see. It waits at "All set" for an explicit Start, even after the page shows again.
 * Escape, ×, Back and Exit leave the page; this hook then unmounts with it, so nothing starts.
 */
export function useCloudSetupAutoStart({
  done,
  visible,
  settleMs
}: {
  done: boolean
  visible: boolean
  settleMs: number
}): { starting: boolean; heldForStart: boolean; start: () => void } {
  const [starting, setStarting] = useState(false)
  const [heldForStart, setHeldForStart] = useState(false)
  useEffect(() => {
    if (!done || starting || heldForStart) {
      return
    }
    if (!visible) {
      setHeldForStart(true)
      return
    }
    const timer = window.setTimeout(() => setStarting(true), settleMs)
    return () => window.clearTimeout(timer)
  }, [done, heldForStart, settleMs, starting, visible])
  const start = useCallback(() => {
    setHeldForStart(false)
    setStarting(true)
  }, [])
  return { starting, heldForStart: heldForStart && !starting, start }
}
