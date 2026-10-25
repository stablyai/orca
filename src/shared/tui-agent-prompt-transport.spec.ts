/** Pin the pre-launch transport predicate to buildAgentStartupPlan’s followupPrompt verdict for every agent so table drift cannot lose prompts. */

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
  // An empty agent list would make the contract vacuously pass.
  it('covers every configured agent', () => {
    expect(ALL_AGENTS.length).toBeGreaterThan(30)
    expect(ALL_AGENTS).toContain('claude')
    expect(ALL_AGENTS).toContain('aider')
  })

  it.each(ALL_AGENTS)('agrees with the built plan for %s', (agent) => {
    const plan = planFor(agent)
    expect(plan).not.toBeNull()
    // The pre-launch predicate must agree with the built plan’s null followupPrompt.
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
