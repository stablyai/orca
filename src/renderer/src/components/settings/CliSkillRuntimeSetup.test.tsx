import { describe, expect, it } from 'vitest'
import {
  buildSkillInstallCommandForRuntime,
  getSkillDiscoveryTargetForRuntime
} from './CliSkillRuntimeSetup'

describe('CliSkillRuntimeSetup runtime helpers', () => {
  it('wraps WSL skill installs in the selected distro login shell', () => {
    const command = buildSkillInstallCommandForRuntime('npx skills add orchestration --global', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })

    expect(command).toContain("wsl.exe -d 'Ubuntu' -- sh -c")
    expect(command).toContain('getent passwd')
    expect(command).toContain('npx skills add orchestration --global')
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
})
