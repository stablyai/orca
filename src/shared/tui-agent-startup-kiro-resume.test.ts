import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'

const SESSION = { key: 'session_id' as const, id: 'sess_008ffb85-0fc5-4805-9a83-f2e9c4f39567' }

describe('Kiro resume startup plan', () => {
  it('appends only --resume-id to the chat launch command', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: {},
      agentArgs: '--trust-all-tools',
      platform: 'darwin'
    })

    // Why: kiro-cli rejects a second `chat --tui` ("the argument '--tui' cannot be used
    // multiple times"), which is what a cold restore typed before this was pinned.
    expect(plan?.launchCommand).toBe(
      `kiro-cli chat --tui '--trust-all-tools' '--resume-id' '${SESSION.id}'`
    )
  })

  it('honors a command override that already selects the V3 engine', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: SESSION,
      cmdOverrides: { kiro: 'kiro-cli chat --tui --v3 --agent work' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(
      `kiro-cli chat --tui --v3 --agent work '--resume-id' '${SESSION.id}'`
    )
  })
})
