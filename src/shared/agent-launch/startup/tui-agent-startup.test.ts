import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'

function promptLaunch(
  agentArgs: string,
  shell: AgentStartupShell,
  agent: TuiAgent = 'claude',
  cmdOverride?: string
): string | undefined {
  return buildAgentStartupPlan({
    agent,
    prompt: 'Reply OK',
    cmdOverrides: cmdOverride ? { [agent]: cmdOverride } : {},
    platform: shell === 'posix' ? 'darwin' : 'win32',
    shell,
    agentArgs
  })?.launchCommand
}

describe('argv prompt separator (#48072)', () => {
  it('ends option parsing so a trailing variadic flag cannot take the prompt', () => {
    expect(promptLaunch('--permission-mode auto --disallowedTools Agent', 'posix')).toBe(
      "claude '--permission-mode' 'auto' '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
  })

  it('quotes the separator so a PowerShell function or .ps1 shim forwards it', () => {
    expect(promptLaunch('--disallowedTools Agent', 'powershell')).toBe(
      "claude '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
    expect(promptLaunch('--disallowedTools Agent', 'cmd')).toBe(
      'claude "--disallowedTools" "Agent" "--" "Reply OK"'
    )
  })

  it('separates the prompt for managed Claude when its PowerShell path contains a backtick and apostrophe', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'Reply OK',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      agentArgs: '--disallowedTools Agent',
      managedAgentCommands: {
        claude: "C:\\Users\\O`'Brien\\agent-runtimes\\claude\\1.2.3\\claude.exe"
      }
    })
    expect(plan?.launchCommand).toBe(
      "& 'C:\\Users\\O`''Brien\\agent-runtimes\\claude\\1.2.3\\claude.exe' '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
  })

  it('adds no second separator when the args already end option parsing', () => {
    expect(promptLaunch('--disallowedTools Agent --', 'posix')).toBe(
      "claude '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
    expect(
      promptLaunch('', 'posix', 'claude', 'mise exec -- claude --disallowedTools Agent --')
    ).toBe("mise exec -- claude --disallowedTools Agent -- 'Reply OK'")
  })

  it('still separates when the `--` is an option value', () => {
    expect(promptLaunch('--append-system-prompt -- --disallowedTools Agent', 'posix')).toBe(
      "claude '--append-system-prompt' '--' '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
  })

  it('ignores a `--` inside a wrapper command override', () => {
    expect(promptLaunch('', 'posix', 'grok', 'mise exec -- grok')).toBe(
      "mise exec -- grok '--' 'Reply OK'"
    )
    expect(promptLaunch('--disallowedTools Agent', 'posix', 'claude', 'mise exec -- claude')).toBe(
      "mise exec -- claude '--disallowedTools' 'Agent' '--' 'Reply OK'"
    )
  })

  it('adds no separator when a Claude override wrapper is not claude itself', () => {
    // Happy appends `--settings <hooks.json>` after the forwarded args.
    expect(promptLaunch('--disallowedTools Agent', 'posix', 'claude', 'happy')).toBe(
      "happy '--disallowedTools' 'Agent' 'Reply OK'"
    )
  })
})
