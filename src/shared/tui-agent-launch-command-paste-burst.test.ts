import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

// Why: Codex's paste burst read relayed typing as a paste and left the prompt unsent (#34496).
describe('Codex paste-burst launch flag', () => {
  it.each([
    ['linux', true],
    ['darwin', true],
    ['win32', false]
  ] as const)('is %s: %s on fresh launches and resumes', (platform, expected) => {
    const flag = "'-c' 'disable_paste_burst=true'"
    const launch = resolveAgentLaunchCommand({
      agent: 'codex',
      cmdOverrides: {},
      platform,
      shell: 'posix'
    })
    const resume = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: {},
      agentCommand: 'codex',
      platform,
      shell: 'posix'
    })
    if (!launch.ok) {
      throw new Error(launch.error)
    }
    expect(launch.command.includes(flag)).toBe(expected)
    expect(launch.resumeLaunch.agentCommand).toBe('codex')
    expect(resume?.launchCommand.includes(flag)).toBe(expected)
  })
  it.each(['codex --', 'codex-wrapper --profile work', 'codex && exec bash'])(
    'leaves %s alone',
    (override) => {
      const launch = resolveAgentLaunchCommand({
        agent: 'codex',
        cmdOverrides: { codex: override },
        platform: 'linux',
        shell: 'posix'
      })
      expect(launch.ok && launch.command).toBe(override)
    }
  )
  it.each(['win32', null] as const)(
    'stays off when the agent host is %s even if quoting is posix',
    (agentHostPlatform) => {
      const resume = buildAgentResumeStartupPlan({
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-1' },
        cmdOverrides: {},
        agentCommand: 'codex',
        platform: 'darwin',
        shell: 'posix',
        agentHostPlatform
      })
      expect(resume?.launchCommand).toBe("codex 'resume' 'thread-1'")
    }
  )
})
