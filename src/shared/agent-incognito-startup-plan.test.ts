import { describe, expect, it } from 'vitest'
import {
  buildIncognitoAwareAgentStartupPlan,
  type IncognitoAwareStartupSettings
} from './agent-incognito-startup-plan'

/**
 * Behavioral coverage for the launch paths that bypass resolveAgentTerminalCreateOptions and now
 * funnel through this shared assembler: the structured-session (createAgentSession) and mobile
 * builders. We build the REAL launch command and assert a capable incognito agent carries the
 * native `--no-session` flag while a non-capable / non-listed one does not — no source greps.
 */
function settings(
  terminalIncognitoAgents: IncognitoAwareStartupSettings['terminalIncognitoAgents']
): IncognitoAwareStartupSettings {
  return {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    terminalIncognitoAgents
  }
}

const HOST = { platform: 'linux' as const, isRemote: false }

describe('buildIncognitoAwareAgentStartupPlan — structured-session shape', () => {
  it('adds --no-session for a capable incognito agent (with picked session options + prompt)', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'pi',
      settings: settings(['pi']),
      ...HOST,
      sessionOptions: { model: 'pi-fast' },
      prompt: 'ship it'
    })
    expect(plan?.launchCommand).toContain('--no-session')
  })

  it('does NOT add --no-session for a non-capable agent even if wrongly listed', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'claude',
      settings: settings(['claude', 'pi']),
      ...HOST,
      prompt: 'ship it'
    })
    expect(plan?.launchCommand).not.toContain('--no-session')
  })

  it('does NOT add --no-session for a capable agent that is not listed', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'pi',
      settings: settings(['omp']),
      ...HOST,
      prompt: 'ship it'
    })
    expect(plan?.launchCommand).not.toContain('--no-session')
  })

  it('adds --no-session on the draft-delivery branch for a capable incognito agent', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'pi',
      settings: settings(['pi']),
      ...HOST,
      promptDelivery: 'draft',
      prompt: 'draft body'
    })
    expect(plan?.launchCommand).toContain('--no-session')
  })
})

describe('buildIncognitoAwareAgentStartupPlan — mobile shape', () => {
  it('adds --no-session for a capable incognito agent (prompt only, no session options)', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'omp',
      settings: settings(['omp']),
      ...HOST,
      prompt: ''
    })
    expect(plan?.launchCommand).toContain('--no-session')
  })

  it('does NOT add --no-session for a non-capable agent', () => {
    const plan = buildIncognitoAwareAgentStartupPlan({
      agent: 'codex',
      settings: settings(['pi', 'omp']),
      ...HOST,
      prompt: ''
    })
    expect(plan?.launchCommand).not.toContain('--no-session')
  })
})
