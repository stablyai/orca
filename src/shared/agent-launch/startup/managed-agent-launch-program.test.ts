import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { agentSessionSignInCommand } from '../../agent-session/lifecycle/launch/agent-session-setup-commands'

const MAC_OPENCODE = '/Users/a b/Library/Application Support/orca/opencode/bin/opencode'
const WIN_OPENCODE = 'C:\\Users\\a b\\AppData\\Roaming\\orca\\opencode\\opencode.exe'

function launch(args: {
  platform: NodeJS.Platform
  shell?: 'posix' | 'powershell' | 'cmd'
  managed?: string
  override?: string
  agentArgs?: string
}) {
  return buildAgentStartupPlan({
    agent: 'opencode',
    prompt: '',
    allowEmptyPromptLaunch: true,
    cmdOverrides: args.override ? { opencode: args.override } : {},
    platform: args.platform,
    agentArgs: args.agentArgs,
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

  it('records a generated head for a stock Command and separate Arguments', () => {
    expect(
      launch({
        platform: 'win32',
        managed: WIN_OPENCODE,
        override: ' OPENCODE ',
        agentArgs: '--verbose'
      })
    ).toMatchObject({
      launchCommand:
        "& 'C:\\Users\\a b\\AppData\\Roaming\\orca\\opencode\\opencode.exe' '--verbose'",
      launchConfig: { commandProvenance: 'generated', selectedExecutable: WIN_OPENCODE }
    })
    expect(
      launch({ platform: 'darwin', managed: MAC_OPENCODE, agentArgs: '--verbose' })
    ).toMatchObject({
      launchCommand:
        "'/Users/a b/Library/Application Support/orca/opencode/bin/opencode' '--verbose'",
      launchConfig: { commandProvenance: 'generated', selectedExecutable: MAC_OPENCODE }
    })
    expect(
      launch({
        platform: 'darwin',
        managed: MAC_OPENCODE,
        override: 'PATH=/scoped/bin opencode   --verbose'
      })
    ).toMatchObject({
      launchCommand: 'PATH=/scoped/bin opencode   --verbose',
      launchConfig: { commandProvenance: 'authored' }
    })
  })

  it('replaces a bare Command Code override head without adding trust flags', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'command-code',
        prompt: '',
        allowEmptyPromptLaunch: true,
        cmdOverrides: { 'command-code': 'command-code' },
        platform: 'linux',
        managedAgentCommands: { 'command-code': '/opt/user tools/bin/command-code' }
      })
    ).toMatchObject({
      launchCommand: "'/opt/user tools/bin/command-code'",
      launchConfig: {
        agentCommand: 'command-code',
        commandProvenance: 'generated',
        selectedExecutable: '/opt/user tools/bin/command-code'
      }
    })
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
