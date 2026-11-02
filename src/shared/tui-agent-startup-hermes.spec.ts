import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import {
  unwrapPosixShellScript,
  unwrapPowerShellScript
} from './tui-agent-startup-script.test-fixture'

// Hermes is the only agent whose launch Orca rewrites token by token — it owns the startup query,
// the TUI mode, and where an override's flags may sit relative to the chat subcommand. Its cases
// outgrew the general startup-plan file.

describe('hermes startup plans', () => {
  it('moves Hermes command override flags after the chat subcommand', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run privately',
      cmdOverrides: { hermes: 'hermes --tui --provider anthropic' },
      agentArgs: '--yolo',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script).toContain("'--provider' 'anthropic' '--yolo' '--tui'")
    expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe('run privately')
  })

  it.each([
    {
      shell: 'powershell' as const,
      override: '"C:\\Program Files\\Hermes\\hermes.exe" --tui',
      expected: "& 'C:\\Program Files\\Hermes\\hermes.exe' 'chat'"
    },
    {
      shell: 'cmd' as const,
      override: 'C:\\Tools\\hermes.exe --tui',
      expected: "& 'C:\\Tools\\hermes.exe' 'chat'"
    }
  ])('preserves Windows paths in Hermes command overrides on $shell', (testCase) => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: testCase.override },
      platform: 'win32',
      shell: testCase.shell
    })

    expect(unwrapPowerShellScript(plan?.launchCommand)).toContain(testCase.expected)
  })

  it('removes a configured duplicate chat subcommand', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes --provider copilot chat --tui' },
      agentArgs: '--provider copilot chat --yolo',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/'chat'/g)).toHaveLength(1)
    expect(script).toContain("'--provider' 'copilot' '--yolo'")
  })

  it('preserves an option value named chat', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes --profile chat --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain("'--profile' 'chat'")
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

  it('preserves wrapper tokens before the Hermes executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'uv run hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain("'uv' 'run' 'hermes' 'chat'")
  })

  it('selects the final Hermes executable token in a wrapper', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'sudo -u hermes hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain(
      "'sudo' '-u' 'hermes' 'hermes' 'chat'"
    )
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

  it('rejects Hermes queries that exceed the safe Windows environment limit', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'x'.repeat(24_000),
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan).toBeNull()
  })

  it.each(['quote "this"', 'print %PATH%', 'toggle !feature!', 'inspect C:\\repo\\'])(
    'keeps a complex cmd Hermes query out of command text: %s',
    (prompt) => {
      const plan = buildAgentStartupPlan({
        agent: 'hermes',
        prompt,
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })

      expect(plan?.launchCommand).not.toContain(prompt)
      expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe(prompt)
    }
  )

  it('uses the Windows remote default shell for SSH Hermes queries', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run remotely',
      cmdOverrides: {},
      platform: 'win32',
      isRemote: true
    })

    expect(unwrapPowerShellScript(plan?.launchCommand)).toContain(
      "& 'hermes' 'chat' \"--query=$orcaHermesNativeQuery\" '--tui'"
    )
  })

  it('measures POSIX Hermes query limits in UTF-8 bytes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: '界'.repeat(50_000),
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toBeNull()
  })

  it('keeps empty Hermes launches on the interactive TUI command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('hermes --tui')
    expect(plan?.followupPrompt).toBeNull()
  })
})
