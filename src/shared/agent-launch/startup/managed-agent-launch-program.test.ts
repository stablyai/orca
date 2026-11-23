import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { agentSessionSignInCommand } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

const MAC_CLAUDE = '/Users/a b/Library/Application Support/orca/claude/bin/claude'
const WIN_CLAUDE = 'C:\\Users\\a b\\AppData\\Roaming\\orca\\claude\\claude.exe'

function launch(args: {
  platform: NodeJS.Platform
  shell?: 'posix' | 'powershell' | 'cmd'
  managed?: string
  override?: string
}) {
  return buildAgentStartupPlan({
    agent: 'claude',
    prompt: '',
    allowEmptyPromptLaunch: true,
    cmdOverrides: args.override ? { claude: args.override } : {},
    platform: args.platform,
    shell: args.shell,
    managedAgentCommands: args.managed ? { claude: args.managed } : undefined
  })
}

describe("launching Orca's copy of an agent", () => {
  it('runs it by full path, quoted for each shell', () => {
    expect(launch({ platform: 'darwin', managed: MAC_CLAUDE })?.launchCommand).toBe(
      "'/Users/a b/Library/Application Support/orca/claude/bin/claude'"
    )
    expect(
      launch({ platform: 'win32', shell: 'powershell', managed: WIN_CLAUDE })?.launchCommand
    ).toBe("& 'C:\\Users\\a b\\AppData\\Roaming\\orca\\claude\\claude.exe'")
    expect(launch({ platform: 'win32', shell: 'cmd', managed: WIN_CLAUDE })?.launchCommand).toBe(
      '"C:\\Users\\a b\\AppData\\Roaming\\orca\\claude\\claude.exe"'
    )
  })

  it("keeps the user's own CLI and a Command setting naming another program", () => {
    expect(launch({ platform: 'darwin' })?.launchCommand).toBe('claude')
    expect(
      launch({ platform: 'darwin', managed: MAC_CLAUDE, override: '~/bin/claude' })?.launchCommand
    ).toBe('~/bin/claude')
    expect(
      launch({ platform: 'darwin', managed: MAC_CLAUDE, override: 'claude --verbose' })
        ?.launchCommand
    ).toBe("'/Users/a b/Library/Application Support/orca/claude/bin/claude' --verbose")
  })

  it('uses the same program replacement for stock settings with launch environment prefixes', () => {
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_CLAUDE,
        override: "env -u TRACE DEBUG=1 claude   '--verbose'"
      })?.launchCommand
    ).toBe(
      "env -u TRACE DEBUG=1 '/Users/a b/Library/Application Support/orca/claude/bin/claude'   '--verbose'"
    )
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_CLAUDE,
        override: 'DEBUG=1 claude --verbose'
      })?.launchCommand
    ).toBe("DEBUG=1 '/Users/a b/Library/Application Support/orca/claude/bin/claude' --verbose")
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_CLAUDE,
        override: "/bin/sh -c 'claude --verbose'"
      })?.launchCommand
    ).toBe("/bin/sh -c 'claude --verbose'")
  })

  it('records the stock name, so a resume finds the copy the host has then', () => {
    expect(launch({ platform: 'darwin', managed: MAC_CLAUDE })?.launchConfig.agentCommand).toBe(
      'claude'
    )
    const resumed = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'abc' },
      cmdOverrides: {},
      agentCommand: 'claude --model opus',
      platform: 'darwin',
      managedAgentCommands: { claude: '/opt/orca/claude' }
    })
    expect(resumed?.launchCommand).toBe("'/opt/orca/claude' --model opus '--resume' 'abc'")
  })

  it('signs in through it by full path', () => {
    expect(
      agentSessionSignInCommand('codex', {
        remote: false,
        shell: 'posix',
        managedCommand: '/opt/orca/codex'
      })
    ).toBe("'/opt/orca/codex' 'login'")
    expect(
      agentSessionSignInCommand('codex', {
        remote: false,
        shell: 'powershell',
        managedCommand: 'C:\\orca\\codex.exe'
      })
    ).toBe("& 'C:\\orca\\codex.exe' 'login'")
    expect(agentSessionSignInCommand('codex', { remote: false, shell: 'posix' })).toBe(
      'codex login'
    )
  })
})
