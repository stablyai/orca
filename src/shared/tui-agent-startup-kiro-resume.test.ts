import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

describe('Kiro cold restore', () => {
  it.each([
    ['darwin', 'posix', "kiro-cli chat --tui '--trust-all-tools' '--resume-id' 'session-1'"],
    ['linux', 'posix', "kiro-cli chat --tui '--trust-all-tools' '--resume-id' 'session-1'"],
    ['win32', 'powershell', "kiro-cli chat --tui '--trust-all-tools' '--resume-id' 'session-1'"],
    ['win32', 'cmd', 'kiro-cli chat --tui "--trust-all-tools" "--resume-id" "session-1"']
  ] as const)('appends only the resume selector on %s/%s', (platform, shell, expected) => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: { key: 'session_id', id: 'session-1' },
      cmdOverrides: {},
      agentArgs: '--trust-all-tools',
      platform,
      shell
    })
    expect(plan?.launchCommand).toBe(expected)
  })

  it('preserves the captured engine and agent selection on a remote host', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: { key: 'session_id', id: 'session-1' },
      cmdOverrides: {},
      agentCommand: 'kiro-cli chat --tui --v2 --agent reviewer',
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.launchCommand).toBe(
      "kiro-cli chat --tui --v2 --agent reviewer '--resume-id' 'session-1'"
    )
  })

  it('resumes a V3 session through a command override that selects the V3 engine', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'kiro',
      providerSession: { key: 'session_id', id: 'sess_008ffb85-0fc5-4805-9a83-f2e9c4f39567' },
      cmdOverrides: { kiro: 'kiro-cli chat --tui --v3 --agent work' },
      platform: 'linux'
    })
    expect(plan?.launchCommand).toBe(
      "kiro-cli chat --tui --v3 --agent work '--resume-id' 'sess_008ffb85-0fc5-4805-9a83-f2e9c4f39567'"
    )
  })
})
