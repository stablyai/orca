import { describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'

const agentTeams = TUI_AGENT_CONFIG['claude-agent-teams']

describe('Claude Agent Teams launch name on the launching host', () => {
  it('uses plain orca on a headless Linux server, whose PATH has no orca-ide (#33920)', () => {
    installFakeAppEnvironment({ getCliLauncherPath: () => '/home/u/.orca/cli/bin/orca' })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('orca claude-teams')
  })

  it('keeps the orca-ide rename on a Linux desktop', () => {
    installFakeAppEnvironment({ getCliLauncherPath: undefined })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('orca-ide claude-teams')
  })

  it('keeps the orca-ide rename for WSL under a Windows server', () => {
    installFakeAppEnvironment({
      getCliLauncherPath: () => 'C:\\Users\\u\\.orca\\cli\\bin\\orca.exe'
    })
    expect(getTuiAgentLaunchCommand(agentTeams, 'linux')).toBe('orca-ide claude-teams')
  })
})
