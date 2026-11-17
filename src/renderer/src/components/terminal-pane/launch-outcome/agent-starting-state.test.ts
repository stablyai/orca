import { describe, expect, it } from 'vitest'
import {
  AGENT_STARTING_SLOW_MS,
  AGENT_STARTING_STILL_MS,
  AGENT_STARTING_WINDOW_MS,
  agentStartingPhase,
  isAgentLaunchLeaf,
  terminalHasVisibleContent
} from './agent-starting-state'

function buffer(lines: string[]) {
  return {
    active: {
      length: lines.length,
      getLine: (y: number) => (y < lines.length ? { translateToString: () => lines[y] } : undefined)
    }
  }
}

describe('agent starting status', () => {
  it('a pane with only a cursor (escape setup, blank rows) is still starting; any text ends it', () => {
    expect(terminalHasVisibleContent(buffer(['', '   ', '']))).toBe(false)
    expect(terminalHasVisibleContent(buffer(['', ' ╭─ Claude Code']))).toBe(true)
  })

  it('shows only on the launched agent’s pane, and only for a fresh launch', () => {
    const now = 1_000_000
    const tab = { launchAgent: 'claude', createdAt: now - 1_000 }
    expect(isAgentLaunchLeaf(tab, 'leaf-1', 1, now)).toBe(true)
    // A split beside it is a plain terminal.
    expect(isAgentLaunchLeaf(tab, 'leaf-2', 2, now)).toBe(false)
    expect(
      isAgentLaunchLeaf({ ...tab, agentLaunchPane: { leafId: 'leaf-2' } }, 'leaf-2', 2, now)
    ).toBe(true)
    // A plain terminal tab, or a restored launch from long ago (a reattach, not a start).
    expect(isAgentLaunchLeaf({ createdAt: now }, 'leaf-1', 1, now)).toBe(false)
    expect(
      isAgentLaunchLeaf({ ...tab, createdAt: now - AGENT_STARTING_WINDOW_MS - 1 }, 'leaf-1', 1, now)
    ).toBe(false)
  })

  it('says "still starting" past 10 s and adds the slow line past 20 s', () => {
    expect(agentStartingPhase(AGENT_STARTING_STILL_MS - 1)).toBe('starting')
    expect(agentStartingPhase(AGENT_STARTING_STILL_MS)).toBe('still')
    expect(agentStartingPhase(AGENT_STARTING_SLOW_MS - 1)).toBe('still')
    expect(agentStartingPhase(AGENT_STARTING_SLOW_MS)).toBe('slow')
  })
})
