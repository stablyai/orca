import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getSelectedAgentRuntime } from './CliSkillRuntimeSetup'

describe('CliSkillRuntimeSetup runtime helpers', () => {
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
