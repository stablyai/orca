// "Starting <agent>…" while a launched agent's pane is still blank. A cloud agent starts behind
// a shell whose echo is erased, so between the pane attaching and the agent's first frame there is
// only a cursor; this says what is happening instead (Neil, n70: a blank cursor for ~10 s).

/** Below this, the agent usually draws first: no status flashes by. */
export const AGENT_STARTING_DELAY_MS = 600
/** Past this, the status says it's taking longer than usual. */
export const AGENT_STARTING_SLOW_MS = 20_000
/** Past this the title says "Still starting": a first launch can sit on its own setup (n73: OpenCode's plugin install). */
export const AGENT_STARTING_STILL_MS = 10_000

export type AgentStartingPhase = 'starting' | 'still' | 'slow'

/** Which wording the starting overlay shows after `elapsedMs`. */
export function agentStartingPhase(elapsedMs: number): AgentStartingPhase {
  if (elapsedMs >= AGENT_STARTING_SLOW_MS) {
    return 'slow'
  }
  return elapsedMs >= AGENT_STARTING_STILL_MS ? 'still' : 'starting'
}

type BufferLike = {
  active: {
    length: number
    getLine: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined
  }
}

/** Whether anything visible has been drawn yet (escape sequences and cursor moves don't count). */
export function terminalHasVisibleContent(buffer: BufferLike): boolean {
  const { active } = buffer
  for (let y = 0; y < active.length; y++) {
    if (active.getLine(y)?.translateToString(true).trim()) {
      return true
    }
  }
  return false
}

/** Only a launch this recent can still be starting; an older blank pane is a reattach, not a start. */
export const AGENT_STARTING_WINDOW_MS = 3 * 60_000

/**
 * The pane that runs the tab's freshly launched agent: its recorded leaf, else the tab's only pane.
 */
export function isAgentLaunchLeaf(
  tab:
    | { launchAgent?: string; agentLaunchPane?: { leafId: string }; createdAt: number }
    | null
    | undefined,
  leafId: string,
  paneCount: number,
  now: number
): boolean {
  if (!tab?.launchAgent || now - tab.createdAt > AGENT_STARTING_WINDOW_MS) {
    return false
  }
  return tab.agentLaunchPane ? tab.agentLaunchPane.leafId === leafId : paneCount === 1
}
