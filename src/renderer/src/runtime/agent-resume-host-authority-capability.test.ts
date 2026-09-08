import { describe, expect, it } from 'vitest'
import { RESUMABLE_TUI_AGENTS } from '../../../shared/agent-session-resume'
import {
  AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../shared/protocol-version'
import { agentResumeHostAuthorityCapability } from './agent-resume-host-authority-capability'

describe('agentResumeHostAuthorityCapability', () => {
  it.each([
    ['kimi', AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY],
    ['cursor', AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY],
    ['omp', AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY]
  ] as const)('gates %s resume behind its own capability', (agent, capability) => {
    expect(agentResumeHostAuthorityCapability(agent)).toBe(capability)
  })

  it('leaves agents shipped with host authority on the generic probe', () => {
    expect(agentResumeHostAuthorityCapability('codex')).toBeUndefined()
    expect(agentResumeHostAuthorityCapability(null)).toBeUndefined()
    expect(agentResumeHostAuthorityCapability(undefined)).toBeUndefined()
  })

  it.each([
    AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
    AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY
  ])('advertises %s from the host', (capability) => {
    expect(RUNTIME_CAPABILITIES).toContain(capability)
  })

  it('pins the gate for every resumable agent so a new member is a deliberate decision', () => {
    // Why: silently defaulting a newly resumable agent to the generic probe is the exact skew
    // failure this module exists to prevent — the mapping must be reviewed, not inherited.
    expect(
      Object.fromEntries(
        RESUMABLE_TUI_AGENTS.map((agent) => [agent, agentResumeHostAuthorityCapability(agent)])
      )
    ).toEqual({
      claude: undefined,
      codex: undefined,
      gemini: undefined,
      antigravity: undefined,
      opencode: undefined,
      pi: undefined,
      'mimo-code': undefined,
      droid: undefined,
      grok: undefined,
      devin: undefined,
      'prime-agent': undefined,
      copilot: undefined,
      omp: AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
      kimi: AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
      cursor: AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY
    })
  })
})
