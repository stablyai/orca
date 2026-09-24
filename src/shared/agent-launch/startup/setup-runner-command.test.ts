import { describe, expect, it } from 'vitest'
import { applySetupAutoCloseSetting, exitedOnSetupSuccess } from './setup-runner-command'

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
