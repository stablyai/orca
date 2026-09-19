import { describe, expect, it } from 'vitest'
import { resolveAntigravityInstallTarget } from './antigravity-install-target'
import { buildSkillSetupTerminalCommand } from '../settings/CliSkillRuntimeSetup'

describe('Antigravity onboarding install target', () => {
  it.each(['darwin', 'linux'] as const)(
    'uses bash on %s regardless of the preferred shell',
    (platform) => {
      expect(resolveAntigravityInstallTarget(platform, undefined, true)).toMatchObject({
        command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        shellOverride: '/bin/bash',
        runtime: { runtime: 'host' }
      })
    }
  )

  it('forces PowerShell for the Windows installer even when cmd or Git Bash is preferred', () => {
    expect(resolveAntigravityInstallTarget('win32', undefined, true)).toMatchObject({
      command: 'irm https://antigravity.google/cli/install.ps1 | iex',
      shellOverride: 'powershell.exe'
    })
  })

  it('uses the detection distro and adapts the POSIX installer to the created shell', () => {
    const target = resolveAntigravityInstallTarget('win32', { wslDistro: 'Ubuntu-24.04' }, true)
    expect(target).not.toBeNull()
    if (!target) {
      throw new Error('Expected WSL target')
    }
    const command = buildSkillSetupTerminalCommand(
      target.command,
      target.shellOverride,
      target.runtime,
      target.platform
    )
    expect(command).toContain('wsl.exe')
    expect(command).toContain("-d 'Ubuntu-24.04'")
    expect(command).toContain('--exec')
    expect(command).not.toContain('install.ps1')
    expect(
      buildSkillSetupTerminalCommand(target.command, 'wsl.exe', target.runtime, target.platform)
    ).toBe(target.command)
  })

  it('does not install on a guessed host or broken WSL runtime', () => {
    expect(resolveAntigravityInstallTarget('darwin', undefined, false)).toBeNull()
    expect(
      resolveAntigravityInstallTarget(
        'win32',
        {
          projectRuntime: {
            status: 'repair-required',
            repair: {
              projectId: 'folder-project',
              preferredRuntime: { kind: 'wsl', distro: null },
              reason: 'wsl-distro-required',
              source: 'global-default',
              cacheKey: 'repair'
            }
          }
        },
        true
      )
    ).toBeNull()
  })
})
