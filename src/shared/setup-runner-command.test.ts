import { describe, expect, it } from 'vitest'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath
} from './setup-runner-command'

describe('buildSetupRunnerCommand', () => {
  it('uses bash for WSL UNC runner scripts regardless of host casing', () => {
    expect(
      buildSetupRunnerCommand(
        '\\\\WSL.LOCALHOST\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        'windows'
      )
    ).toBe('bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh')
  })

  it('uses bash with Linux paths for forward-slash WSL UNC runner scripts', () => {
    expect(
      buildSetupRunnerCommand(
        '//wsl.localhost/Ubuntu/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh',
        'windows'
      )
    ).toBe('bash /home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh')
  })

  it('keeps generic forward-slash UNC runner scripts on cmd.exe', () => {
    expect(
      buildSetupRunnerCommand('//server/share/repo/.git/orca/setup-runner.cmd', 'windows')
    ).toBe('cmd.exe /c "//server/share/repo/.git/orca/setup-runner.cmd"')
  })

  it('uses POSIX launch semantics for native Windows runners when the setup shell is POSIX', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix'
      })
    ).toBe('bash /c/repo/.git/orca/setup-runner.sh')
  })

  it('uses the selected PowerShell executable for PowerShell setup runners', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.ps1', 'windows', {
        family: 'powershell',
        executable: 'pwsh.exe'
      })
    ).toBe(
      'pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\repo\\.git\\orca\\setup-runner.ps1"'
    )
  })

  it('keeps cmd.exe launch semantics for cmd setup runners', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
        family: 'cmd'
      })
    ).toBe('cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd"')
  })

  it('infers generated Windows runner shell semantics from extension when metadata is absent', () => {
    expect(buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows')).toBe(
      'bash /c/repo/.git/orca/setup-runner.sh'
    )
    expect(buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.ps1', 'windows')).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\repo\\.git\\orca\\setup-runner.ps1"'
    )
  })
})

describe('getSetupRunnerCommandPlatformForPath', () => {
  it('prefers POSIX for absolute POSIX runner paths even from Windows clients', () => {
    expect(
      getSetupRunnerCommandPlatformForPath('/remote/repo/.git/orca/setup-runner.sh', 'windows')
    ).toBe('posix')
  })

  it('prefers Windows for native Windows runner paths even from POSIX clients', () => {
    expect(
      getSetupRunnerCommandPlatformForPath('C:\\repo\\.git\\orca\\setup-runner.cmd', 'posix')
    ).toBe('windows')
  })

  it('keeps WSL UNC paths on the Windows resolver so they can be converted', () => {
    expect(
      getSetupRunnerCommandPlatformForPath(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\orca\\setup-runner.sh',
        'posix'
      )
    ).toBe('windows')
  })

  it('keeps forward-slash UNC paths on the Windows resolver', () => {
    expect(
      getSetupRunnerCommandPlatformForPath(
        '//wsl.localhost/Ubuntu/home/jin/repo/.git/orca/setup-runner.sh',
        'posix'
      )
    ).toBe('windows')
    expect(
      getSetupRunnerCommandPlatformForPath(
        '//server/share/repo/.git/orca/setup-runner.cmd',
        'posix'
      )
    ).toBe('windows')
  })
})
