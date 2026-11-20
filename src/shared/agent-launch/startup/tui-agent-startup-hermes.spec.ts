import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { unwrapPosixShellScript } from './tui-agent-startup-script.test-fixture'

// Hermes owns startup query/TUI/subcommand flag placement; keep its token-rewrite cases together.

describe('hermes startup plans', () => {
  it('removes a duplicate chat subcommand and preserves chat as an option value', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: {
        hermes: 'hermes --provider copilot --profile chat --model example chat --tui'
      },
      agentArgs: '--provider copilot chat --yolo',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/'chat'/g)).toHaveLength(2)
    expect(script).toContain("'--provider' 'copilot' '--yolo'")
    expect(script).toContain("'--profile' 'chat'")
  })

  it('keeps Orca ownership of the Hermes startup query and TUI mode', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'automation prompt',
      cmdOverrides: { hermes: 'hermes --query override --cli' },
      agentArgs: '-q=second-override --query=third-override -qfourth-override --tui',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/--query=/g)).toHaveLength(1)
    expect(script).not.toContain('override')
    expect(script).not.toContain("'--cli'")
    expect(script.match(/'--tui'/g)).toHaveLength(1)
    expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe('automation prompt')
  })

  it('selects the wrapped executable when the wrapper and command both name Hermes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'sudo -u hermes hermes chat --tui' },
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script).toContain("'sudo' '-u' 'hermes' 'hermes' 'chat'")
    expect(script.match(/'chat'/g)).toHaveLength(1)
  })

  it('does not mistake a Hermes option value for a wrapped executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes chat --resume hermes --tui' },
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/'chat'/g)).toHaveLength(1)
    expect(script).toContain("'--resume' 'hermes'")
  })

  it('preserves POSIX environment-assignment command prefixes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'HERMES_HOME=/tmp/test uv run hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain(
      "'env' 'HERMES_HOME=/tmp/test' 'uv' 'run' 'hermes' 'chat'"
    )
  })

  it('rejects a Hermes command override with no identifiable executable', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'hermes',
        prompt: 'run it',
        cmdOverrides: { hermes: 'custom-agent --tui' },
        platform: 'linux'
      })
    ).toBeNull()
  })

  it('keeps the override and agent args of a prompted Hermes launch when it resumes', () => {
    const launch = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'start work',
      cmdOverrides: { hermes: 'hermes --profile work' },
      agentArgs: '--yolo',
      platform: 'linux'
    })
    const resume = buildAgentResumeStartupPlan({
      agent: 'hermes',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { hermes: 'hermes --profile work' },
      platform: 'linux',
      agentCommand: launch?.launchConfig.agentCommand,
      agentArgs: launch?.launchConfig.agentArgs
    })

    expect(resume?.launchCommand).toBe("hermes --profile work '--yolo' '--resume' 's1'")
  })
})
