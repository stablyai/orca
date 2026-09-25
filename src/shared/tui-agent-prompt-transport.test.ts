/**
 * The two answers to "how does this agent take its prompt" must stay one answer.
 *
 * `buildAgentStartupPlan` decides by building a command and leaving `followupPrompt` null when the
 * text went into it. `agentPromptRidesLaunchCommand` has to give the same verdict BEFORE a command
 * exists, because `agent.launch` picks a delivery while it is still choosing what to create. Two
 * readings of one table is exactly the shape that drifts, so this pins them together across every
 * agent: add an agent, or change its injection mode, and the disagreement fails here rather than
 * silently dropping that agent's launch prompt.
 */

import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { agentPromptRidesLaunchCommand, buildAgentStartupPlan } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the config is declared as a total record over TuiAgent, so its own keys are that union.
const ALL_AGENTS = Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]

const PROMPT = 'summarize the diff'

function planFor(agent: TuiAgent) {
  return buildAgentStartupPlan({
    agent,
    prompt: PROMPT,
    cmdOverrides: {},
    platform: 'darwin'
  })
}

describe('the prompt-transport predicate against the plan it predicts', () => {
  // A positive control: an empty list would make every assertion below vacuously true.
  it('covers every configured agent', () => {
    expect(ALL_AGENTS.length).toBeGreaterThan(30)
    expect(ALL_AGENTS).toContain('claude')
    expect(ALL_AGENTS).toContain('aider')
  })

  it.each(ALL_AGENTS)('agrees with the built plan for %s', (agent) => {
    const plan = planFor(agent)
    expect(plan).not.toBeNull()
    // `followupPrompt` is the plan saying "the command does NOT carry this"; the predicate must
    // say the same thing, and it is read before any plan is built.
    expect(plan!.followupPrompt === null).toBe(agentPromptRidesLaunchCommand(agent))
  })

  it('puts the prompt in the launch command exactly when it says it does', () => {
    for (const agent of ALL_AGENTS) {
      const plan = planFor(agent)
      if (!agentPromptRidesLaunchCommand(agent)) {
        // The command must not smuggle the text in some other way.
        expect(plan!.launchCommand).not.toContain(PROMPT)
        expect(plan!.followupPrompt).toBe(PROMPT)
        continue
      }
      // Hermes hands long text through an env var, so the command names the variable, not the text.
      const carried =
        plan!.launchCommand.includes(PROMPT) ||
        Object.values(plan!.env ?? {}).some((value) => value.includes(PROMPT))
      expect(carried, `${agent} claims its launch command carries the prompt`).toBe(true)
    }
  })

  it('splits the table into both halves, so neither branch is untested', () => {
    const folded = ALL_AGENTS.filter(agentPromptRidesLaunchCommand)
    const written = ALL_AGENTS.filter((agent) => !agentPromptRidesLaunchCommand(agent))
    expect(folded.length).toBeGreaterThan(0)
    expect(written.length).toBeGreaterThan(0)
    expect(folded).toContain('claude')
    expect(written).toContain('aider')
  })
})
