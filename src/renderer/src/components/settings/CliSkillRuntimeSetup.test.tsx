import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  buildSkillCommandForRuntime,
  buildSkillSetupTerminalCommand,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime
} from './CliSkillRuntimeSetup'

describe('CliSkillRuntimeSetup runtime helpers', () => {
  it('keeps the WSL command native and wraps the selected distro for a PowerShell terminal', () => {
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Fedora Remix',
      label: 'WSL Fedora Remix'
    } as const
    const command =
      'npx skills@1.7.2 add https://github.com/stablyai/orca/tree/abc --skill orca-cli --global'
    expect(buildSkillCommandForRuntime(command, runtime, 'win32')).toBe(command)
    const wrapped = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')
    expect(wrapped).toContain("wsl.exe -d 'Fedora Remix' --exec sh -c")
    expect(wrapped).toContain(`} # Runs: ${command}`)
    expect(wrapped).not.toContain('where.exe npx')
    expect(buildSkillSetupTerminalCommand(wrapped, 'wsl.exe', runtime, 'win32')).toContain(command)
  })

  it('preserves the selected WSL distro for skill discovery', () => {
    expect(
      getSkillDiscoveryTargetForRuntime({
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        label: 'WSL Ubuntu'
      })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses the global project runtime default instead of stale WSL agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Debian',
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian',
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        },
        true,
        true,
        false
      )
    ).toMatchObject({ runtime: 'host' })
  })

  it('uses the WSL global project runtime default instead of stale host agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'host',
          terminalWindowsShell: 'powershell.exe',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        true,
        true,
        false
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' })
  })
})
