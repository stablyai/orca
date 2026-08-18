import { describe, expect, it } from 'vitest'
import {
  buildSetupRunnerCommand,
  getSetupRunnerCommandPlatformForPath,
  nativeWindowsPathToPosixShellPath,
  resolveSetupRunnerCommand
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

  it('uses the active WSL shell with WSL paths for native Windows POSIX runners', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix',
        executable: 'wsl.exe'
      })
    ).toBe('bash /mnt/c/repo/.git/orca/setup-runner.sh')
  })

  it('keeps cmd.exe launch semantics for cmd setup runners', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
        family: 'cmd'
      })
    ).toBe('cmd.exe /c "C:\\repo\\.git\\orca\\setup-runner.cmd"')
  })

  it('infers generated POSIX runner shell semantics from extension when metadata is absent', () => {
    expect(buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows')).toBe(
      'bash /c/repo/.git/orca/setup-runner.sh'
    )
  })

  it('never hands a batch runner to bash, even from a Git Bash pane', () => {
    // Regression: a Git Bash terminal with a batch-syntax setup script gets a .cmd runner,
    // so the launch shell being POSIX must not be read as "the runner is a shell script".
    const command = buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
      family: 'posix'
    })

    expect(command).not.toContain('bash ')
    expect(command).not.toContain('/c/repo')
  })

  it('avoids the bare /c switch when a POSIX pane launches a batch runner', () => {
    // Regression (#6896): MSYS rewrites `cmd.exe /c` into a drive path inside Git Bash, so cmd
    // opens interactively and the runner payload never executes.
    const command = buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
      family: 'posix'
    })

    expect(command).not.toContain('cmd.exe /c')
    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/
    )
  })

  it('keeps the batch runner path in native form for a POSIX pane launch', () => {
    // Why: the PowerShell launcher hands the path to cmd, which cannot read /c/... MSYS paths;
    // marker and completion paths derive from this value too.
    expect(
      resolveSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
        family: 'posix'
      })
    ).toMatchObject({
      runnerScriptPathForShell: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
      shell: 'windows'
    })
  })

  it('still uses bash for a POSIX runner launched from a POSIX pane', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix'
      })
    ).toBe('bash /c/repo/.git/orca/setup-runner.sh')
  })
})

describe('buildSetupRunnerCommand cmd metacharacter guard', () => {
  const cmdRunner = (segment: string) => `C:\\repo${segment}\\.git\\orca\\setup-runner.cmd`
  const decodePowerShellCommand = (command: string): string => {
    const encoded = command.match(/-EncodedCommand (\S+)$/)?.[1]
    expect(encoded).toBeTruthy()
    const bytes = atob(encoded as string)
    let decoded = ''
    for (let index = 0; index < bytes.length; index += 2) {
      decoded += String.fromCharCode(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8))
    }
    return decoded
  }

  it.each(['%', '&', '|', '<', '>', '^', '(', ')', '!', ',', ';', '=', '$', '`'])(
    'hardens the launch when the runner path contains %s',
    (character) => {
      const command = buildSetupRunnerCommand(cmdRunner(`\\a${character}b`), 'windows', {
        family: 'cmd'
      })

      expect(command).toMatch(
        /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand [A-Za-z0-9+/=]+$/
      )
    }
  )

  it.each([
    ['plain', 'C:\\repo\\.git\\orca\\setup-runner.cmd'],
    ['spaces', 'C:\\Program Files\\repo\\.git\\orca\\setup-runner.cmd'],
    ['single quote', "C:\\o'brien\\.git\\orca\\setup-runner.cmd"],
    ['brackets and dash', 'C:\\repo-[2]\\.git\\orca\\setup-runner.cmd']
  ])('keeps the plain cmd launch for a %s path', (_label, runnerScriptPath) => {
    expect(buildSetupRunnerCommand(runnerScriptPath, 'windows', { family: 'cmd' })).toBe(
      `cmd.exe /c "${runnerScriptPath}"`
    )
  })

  it('passes the runner path through the environment rather than the cmd argument string', () => {
    const runnerScriptPath = cmdRunner('\\100%%\\a&b')
    const script = decodePowerShellCommand(
      buildSetupRunnerCommand(runnerScriptPath, 'windows', { family: 'cmd' })
    )

    expect(script).toContain(`$runner = '${runnerScriptPath}'`)
    expect(script).toContain('$processInfo.EnvironmentVariables["ORCA_SETUP_RUNNER"] = $runner')
    expect(script).toContain('/d /s /v:on /c ""!ORCA_SETUP_RUNNER!""')
    // Why: the whole point of the guard is that the hostile path never reaches cmd as syntax.
    expect(script).not.toContain(`/c ""${runnerScriptPath}""`)
    expect(script).toContain('$processInfo.UseShellExecute = $false')
  })

  it('escapes single quotes when embedding the path in the PowerShell literal', () => {
    const script = decodePowerShellCommand(
      buildSetupRunnerCommand("C:\\o'brien&co\\.git\\orca\\setup-runner.cmd", 'windows', {
        family: 'cmd'
      })
    )

    expect(script).toContain("$runner = 'C:\\o''brien&co\\.git\\orca\\setup-runner.cmd'")
  })

  it('leaves runnerScriptPathForShell untouched so marker paths keep the native form', () => {
    const runnerScriptPath = cmdRunner('\\a&b')

    expect(resolveSetupRunnerCommand(runnerScriptPath, 'windows', { family: 'cmd' })).toMatchObject(
      {
        runnerScriptPathForShell: runnerScriptPath,
        shell: 'windows'
      }
    )
  })

  it.each([
    ['native POSIX runner', 'C:\\repo\\a&b\\.git\\orca\\setup-runner.sh', undefined],
    ['WSL UNC runner', '\\\\wsl.localhost\\Ubuntu\\home\\a&b\\orca\\setup-runner.sh', undefined]
  ])('does not disturb the %s launch', (_label, runnerScriptPath) => {
    expect(buildSetupRunnerCommand(runnerScriptPath, 'windows')).toMatch(/^bash /)
  })

  it('does not disturb the wsl.exe POSIX launch', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\a&b\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix',
        executable: 'wsl.exe'
      })
    ).toBe("bash '/mnt/c/repo/a&b/.git/orca/setup-runner.sh'")
  })
})

describe('nativeWindowsPathToPosixShellPath', () => {
  it('converts a drive path to the MSYS form Git Bash uses', () => {
    expect(nativeWindowsPathToPosixShellPath('C:\\Users\\jin\\repo')).toBe('/c/Users/jin/repo')
  })

  it('is idempotent, so a double-applied conversion cannot corrupt a value', () => {
    const once = nativeWindowsPathToPosixShellPath('D:\\repo\\worktrees\\feature')
    expect(nativeWindowsPathToPosixShellPath(once)).toBe(once)
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
