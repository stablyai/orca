/**
 * Terminal agents must agree on argv versus follow-up prompt delivery. Structured-only
 * agents must have a capability-gated provider route and refuse terminal injection;
 * their non-null launch is exercised by dsh-structured-launch-resolution.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { agentPromptRidesLaunchCommand, buildAgentStartupPlan } from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { resolveStructuredNativeChatSupport } from './structured-native-chat-launch-route'
import { RUNTIME_CAPABILITIES } from './protocol-version'
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

describe('prompt transport across terminal and structured launch routes', () => {
  // A positive control: an empty list would make every assertion below vacuously true.
  it('covers every configured agent', () => {
    expect(ALL_AGENTS.length).toBeGreaterThan(30)
    expect(ALL_AGENTS).toContain('claude')
    expect(ALL_AGENTS).toContain('aider')
    expect(ALL_AGENTS).toContain('dsh-acp')
  })

  it.each(ALL_AGENTS)('accounts for the supported launch transport of %s', (agent) => {
    if (TUI_AGENT_CONFIG[agent].launchTransport === 'structured') {
      expect(isAgentSessionHandleProvider(agent)).toBe(true)
      expect(
        resolveStructuredNativeChatSupport({
          agent,
          executionHostId: 'local',
          workspaceKind: 'folder',
          hostCapabilities: RUNTIME_CAPABILITIES
        })
      ).toEqual({ supported: true })
      expect(
        resolveAgentLaunchCommand({ agent, cmdOverrides: {}, platform: 'darwin', shell: 'posix' })
      ).toMatchObject({ ok: false })
      return
    }
    const plan = planFor(agent)
    expect(plan).not.toBeNull()
    // `followupPrompt` is the plan saying "the command does NOT carry this"; the predicate must
    // say the same thing, and it is read before any plan is built.
    expect(plan!.followupPrompt === null).toBe(agentPromptRidesLaunchCommand(agent))
  })

  it('puts the prompt in the launch command exactly when it says it does', () => {
    for (const agent of ALL_AGENTS) {
      if (TUI_AGENT_CONFIG[agent].launchTransport === 'structured') {
        expect(agentPromptRidesLaunchCommand(agent)).toBe(false)
        continue
      }
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
