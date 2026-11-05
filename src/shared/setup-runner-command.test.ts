import { describe, expect, it } from 'vitest'
import {
  applySetupAutoCloseSetting,
  buildSetupRunnerCommand,
  exitedOnSetupSuccess
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

  it('keeps generic forward-slash UNC runner scripts on cmd.exe', () => {
    expect(
      buildSetupRunnerCommand('//server/share/repo/.git/orca/setup-runner.cmd', 'windows')
    ).toBe('cmd.exe /c "//server/share/repo/.git/orca/setup-runner.cmd"')
  })

  it('uses the active WSL shell with WSL paths for native Windows POSIX runners', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix',
        executable: 'wsl.exe'
      })
    ).toBe('bash /mnt/c/repo/.git/orca/setup-runner.sh')
  })

  it('infers generated POSIX runner shell semantics from extension when metadata is absent', () => {
    expect(buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.sh', 'windows')).toBe(
      'bash /c/repo/.git/orca/setup-runner.sh'
    )
  })

  it('avoids the bare /c switch when a POSIX pane launches a batch runner', () => {
    // MSYS rewrites bare cmd.exe /c into a drive path, leaving an interactive cmd instead of executing (#6896).
    const command = buildSetupRunnerCommand('C:\\repo\\.git\\orca\\setup-runner.cmd', 'windows', {
      family: 'posix'
    })

    expect(command).not.toContain('cmd.exe /c')
    expect(command).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/
    )
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

  it('does not disturb the wsl.exe POSIX launch', () => {
    expect(
      buildSetupRunnerCommand('C:\\repo\\a&b\\.git\\orca\\setup-runner.sh', 'windows', {
        family: 'posix',
        executable: 'wsl.exe'
      })
    ).toBe("bash '/mnt/c/repo/a&b/.git/orca/setup-runner.sh'")
  })
})

describe('applySetupAutoCloseSetting', () => {
  const run = 'bash /r/setup-runner.sh'
  const cmdRun = 'cmd.exe /c "C:\\r\\setup-runner.cmd"'
  const psExit = '; if ($LASTEXITCODE -eq 0) { exit 79 }'
  const on = (terminalWindowsShell?: string) => ({
    closeSetupTabOnSuccess: true,
    terminalWindowsShell
  })

  it('only appends the exit clause when the setting is on', () => {
    expect(applySetupAutoCloseSetting(run, 'posix', undefined, undefined)).toBe(run)
    expect(
      applySetupAutoCloseSetting(run, 'posix', undefined, {
        closeSetupTabOnSuccess: false
      })
    ).toBe(run)
    expect(applySetupAutoCloseSetting(run, 'posix', undefined, on())).toBe(`${run} && exit 79`)
  })

  it('uses && exit for POSIX panes: macOS/Linux, SSH, Git Bash and WSL', () => {
    expect(
      applySetupAutoCloseSetting(run, 'windows', { family: 'posix' }, on('powershell.exe'))
    ).toBe(`${run} && exit 79`)
    expect(
      applySetupAutoCloseSetting(run, 'windows', { family: 'posix', executable: 'wsl.exe' }, on(''))
    ).toBe(`${run} && exit 79`)
  })

  it('picks the clause from the configured Windows terminal shell', () => {
    const cmd = { family: 'cmd' } as const
    expect(applySetupAutoCloseSetting(cmdRun, 'windows', cmd, on('C:\\Windows\\cmd.exe'))).toBe(
      `${cmdRun} && exit 79`
    )
    expect(applySetupAutoCloseSetting(cmdRun, 'windows', cmd, on('powershell.exe'))).toBe(
      `${cmdRun}${psExit}`
    )
    expect(applySetupAutoCloseSetting(cmdRun, 'windows', cmd, on('pwsh.exe'))).toBe(
      `${cmdRun}${psExit}`
    )
    // Unset setting and a missing Git Bash both land on PowerShell.
    expect(applySetupAutoCloseSetting(cmdRun, 'windows', cmd, on(''))).toBe(`${cmdRun}${psExit}`)
  })

  it('leaves the command alone when a remote Windows host picks the shell', () => {
    expect(applySetupAutoCloseSetting(cmdRun, 'windows', undefined, on('cmd.exe'))).toBe(cmdRun)
  })

  it('exits only after the last of several sequenced commands', () => {
    const sequenced = `${run}; echo second`
    const closed = applySetupAutoCloseSetting(sequenced, 'posix', undefined, on())
    expect(closed).toBe(`${sequenced} && exit 79`)
    expect(closed.match(/&& exit/g)).toHaveLength(1)
  })

  it('treats only the success clause exit code as a successful setup', () => {
    const posix = applySetupAutoCloseSetting(run, 'posix', undefined, on())
    const ps = applySetupAutoCloseSetting(cmdRun, 'windows', { family: 'cmd' }, on('pwsh.exe'))
    expect(exitedOnSetupSuccess(posix, 79)).toBe(true)
    expect(exitedOnSetupSuccess(ps, 79)).toBe(true)
    // A shell that quits on its own before setup is delivered exits 0, not 79.
    expect(exitedOnSetupSuccess(posix, 0)).toBe(false)
    expect(exitedOnSetupSuccess(posix, 1)).toBe(false)
    expect(exitedOnSetupSuccess(run, 79)).toBe(false)
    expect(exitedOnSetupSuccess(undefined, 79)).toBe(false)
  })
})
