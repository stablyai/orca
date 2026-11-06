import { describe, expect, it } from 'vitest'
import { buildSkillSetupTerminalCommand } from '@/lib/skill-runtime-command'
import { resolveAntigravityInstallTarget } from './antigravity-install-target'

describe('resolveAntigravityInstallTarget', () => {
  it.each(['darwin', 'linux'] as const)('runs install.sh in the user shell on %s', (platform) => {
    const target = resolveAntigravityInstallTarget(platform, { wslDistro: 'Ubuntu' }, true)
    expect(target).toEqual({
      platform,
      command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      runtime: { runtime: 'host', label: '' }
    })
  })

  it('forces PowerShell for the native Windows installer', () => {
    expect(resolveAntigravityInstallTarget('win32', undefined, true)).toMatchObject({
      command: 'irm https://antigravity.google/cli/install.ps1 | iex',
      shellOverride: 'powershell.exe',
      runtime: { runtime: 'host' }
    })
  })

  it('runs install.sh inside the detected WSL distro', () => {
    const target = resolveAntigravityInstallTarget('win32', { wslDistro: 'Ubuntu-24.04' }, true)
    if (!target) {
      throw new Error('Expected a WSL target')
    }
    const wrapped = buildSkillSetupTerminalCommand(
      target.command,
      'powershell.exe',
      target.runtime,
      'win32'
    )
    expect(wrapped).toContain("wsl.exe -d 'Ubuntu-24.04' --exec")
    expect(wrapped).toContain('# Runs: curl -fsSL https://antigravity.google/cli/install.sh | bash')
    // A tab whose shell already resolved to WSL runs the POSIX command directly.
    expect(buildSkillSetupTerminalCommand(target.command, 'wsl.exe', target.runtime, 'win32')).toBe(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash'
    )
  })

  it('offers no install without local terminal authority or with a broken WSL runtime', () => {
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
