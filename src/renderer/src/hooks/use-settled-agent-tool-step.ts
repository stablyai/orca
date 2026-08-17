import { useEffect, useRef, useState } from 'react'

export type AgentToolStep = {
  toolName: string
  toolInput: string
}

/**
 * Minimum time a tool step stays on screen before the next one may replace it.
 * STYLEGUIDE.md: feedback that lives under ~100ms "reads as a glitch"; agents
 * emit several hooks per second, so the row needs a readable floor.
 */
export const AGENT_TOOL_STEP_DWELL_MS = 800

/**
 * Holds an agent's `toolName`/`toolInput` pair steady for a minimum dwell so the
 * row reads instead of flickering (#11075). Steps arriving inside the dwell are
 * coalesced to the newest one, so the pair is always atomic and the last value
 * always lands. Hook events themselves are untouched — this is display only, and
 * every other consumer still sees each event.
 */
export function useSettledAgentToolStep(
  toolName: string,
  toolInput: string,
  dwellMs: number = AGENT_TOOL_STEP_DWELL_MS
): AgentToolStep {
  const [settled, setSettled] = useState<AgentToolStep>(() => ({ toolName, toolInput }))
  const paintedAtRef = useRef<number | null>(null)

  useEffect(() => {
    // Why: mount already painted a step, so its dwell starts here — otherwise the
    // first rewrite after mount lands instantly and the row still flickers once.
    paintedAtRef.current ??= Date.now()
    if (toolName === settled.toolName && toolInput === settled.toolInput) {
      return
    }
    const paint = (): void => {
      paintedAtRef.current = Date.now()
      setSettled({ toolName, toolInput })
    }
    // Why: an ABSOLUTE deadline off the last paint. Rescheduling on the next hook
    // therefore re-aims at the same instant instead of restarting the dwell, which
    // is what lets this effect own its own cleanup without starving the row.
    const remainingMs = paintedAtRef.current + dwellMs - Date.now()
    if (remainingMs <= 0) {
      paint()
      return
    }
    const timer = setTimeout(paint, remainingMs)
    return () => {
      clearTimeout(timer)
    }
  }, [toolName, toolInput, dwellMs, settled])

  return settled
}
