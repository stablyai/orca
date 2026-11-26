import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'
import { agentSessionSignInCommand } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

const MAC_OPENCODE = '/Users/a b/Library/Application Support/orca/opencode/bin/opencode'
const WIN_OPENCODE = 'C:\\Users\\a b\\AppData\\Roaming\\orca\\opencode\\opencode.exe'

function launch(args: {
  platform: NodeJS.Platform
  shell?: 'posix' | 'powershell' | 'cmd'
  managed?: string
  override?: string
}) {
  return buildAgentStartupPlan({
    agent: 'opencode',
    prompt: '',
    allowEmptyPromptLaunch: true,
    cmdOverrides: args.override ? { opencode: args.override } : {},
    platform: args.platform,
    shell: args.shell,
    managedAgentCommands: args.managed ? { opencode: args.managed } : undefined
  })
}

describe('launching a user CLI found outside PATH', () => {
  it('runs it by full path, quoted for each shell', () => {
    expect(launch({ platform: 'darwin', managed: MAC_OPENCODE })?.launchCommand).toBe(
      "'/Users/a b/Library/Application Support/orca/opencode/bin/opencode'"
    )
    expect(
      launch({ platform: 'win32', shell: 'powershell', managed: WIN_OPENCODE })?.launchCommand
    ).toBe("& 'C:\\Users\\a b\\AppData\\Roaming\\orca\\opencode\\opencode.exe'")
    expect(launch({ platform: 'win32', shell: 'cmd', managed: WIN_OPENCODE })?.launchCommand).toBe(
      '"C:\\Users\\a b\\AppData\\Roaming\\orca\\opencode\\opencode.exe"'
    )
  })

  it("keeps the user's own CLI and a Command setting naming another program", () => {
    expect(launch({ platform: 'darwin' })?.launchCommand).toBe('opencode')
    expect(
      launch({ platform: 'darwin', managed: MAC_OPENCODE, override: '~/bin/opencode' })
        ?.launchCommand
    ).toBe('~/bin/opencode')
    expect(
      launch({ platform: 'darwin', managed: MAC_OPENCODE, override: 'opencode --verbose' })
        ?.launchCommand
    ).toBe('opencode --verbose')
  })

  it('preserves commands with launch environment prefixes', () => {
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_OPENCODE,
        override: "env -u TRACE DEBUG=1 opencode   '--verbose'"
      })?.launchCommand
    ).toBe("env -u TRACE DEBUG=1 opencode   '--verbose'")
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_OPENCODE,
        override: 'DEBUG=1 opencode --verbose'
      })?.launchCommand
    ).toBe('DEBUG=1 opencode --verbose')
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_OPENCODE,
        override: "/bin/sh -c 'opencode --verbose'"
      })?.launchCommand
    ).toBe("/bin/sh -c 'opencode --verbose'")
  })

  it('records the stock name, so a resume finds the user CLI on its host', () => {
    expect(launch({ platform: 'darwin', managed: MAC_OPENCODE })?.launchConfig.agentCommand).toBe(
      'opencode'
    )
    const resumed = buildAgentResumeStartupPlan({
      agent: 'opencode',
      providerSession: { key: 'session_id', id: 'abc' },
      cmdOverrides: {},
      agentCommand: 'opencode --model opus',
      platform: 'darwin',
      managedAgentCommands: { opencode: '/opt/orca/opencode' }
    })
    expect(resumed?.launchCommand).toBe("'/opt/orca/opencode' --model opus '--session' 'abc'")
  })

  it('renders native-chat sign-in with a resolved executable', () => {
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
