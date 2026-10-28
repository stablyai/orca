import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildSkillCommandForRuntime, getSelectedAgentRuntime } from './CliSkillRuntimeSetup'

describe('CliSkillRuntimeSetup runtime helpers', () => {
  it('forces English git messages only for POSIX skill install targets', () => {
    const command =
      'npx skills@1.7.2 add https://github.com/stablyai/orca/tree/abc --skill orca-cli'
    const wsl = { runtime: 'wsl' as const, label: 'WSL' }

    expect(buildSkillCommandForRuntime(command, undefined, 'linux')).toBe(`env LC_ALL=C ${command}`)
    expect(buildSkillCommandForRuntime(command, wsl, 'win32')).toBe(`env LC_ALL=C ${command}`)
    expect(buildSkillCommandForRuntime(command, undefined, 'win32')).toMatch(/^cmd\.exe .*\(npx /)
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
