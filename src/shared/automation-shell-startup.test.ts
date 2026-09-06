import { describe, expect, it } from 'vitest'
import { runProcess } from './child-process/run-process'
import { buildAutomationShellStartup } from './automation-shell-startup'

const shell = process.platform === 'win32' ? 'powershell' : 'posix'
const program = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'

async function runCommand(command: string) {
  const startup = buildAutomationShellStartup(command, shell)
  return await runProcess({
    program,
    args:
      shell === 'powershell'
        ? ['-NoProfile', '-NonInteractive', '-Command', startup.command]
        : ['-c', startup.command],
    env: { ...process.env, SHELL: '/bin/sh', ...startup.env },
    timeoutMs: 10_000
  })
}

describe('automation shell startup', () => {
  it('runs multiline commands and exits instead of leaving an idle automation shell', async () => {
    const result = await runCommand(
      shell === 'powershell'
        ? "Write-Output 'first'\nWrite-Output 'second'"
        : "printf '%s\\n' first\nprintf '%s\\n' second"
    )

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stdout.replaceAll('\r\n', '\n')).toBe('first\nsecond\n')
  })

  it('preserves the command exit code', async () => {
    const result = await runCommand('exit 7')
    expect(result.code).toBe(7)
    expect(result.timedOut).toBe(false)
  })

  it('reports a failing final shell command', async () => {
    const result = await runCommand(shell === 'powershell' ? "Write-Error 'failed'" : 'false')
    expect(result.code).toBe(1)
  })

  it('uses the final result after a handled native failure', async () => {
    const result = await runCommand(
      shell === 'powershell'
        ? "cmd.exe /d /c 'exit 7'; Write-Output 'recovered'"
        : "false; printf '%s\\n' recovered"
    )
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('recovered')
  })

  it('reports invalid commands as failures', async () => {
    const result = await runCommand('orca_nonexistent_automation_command')
    expect(result.code).not.toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'keeps %s command text out of the launch wrapper',
    (family) => {
      const command = 'echo "quotes"\necho $HOME %PATH% & other'
      const startup = buildAutomationShellStartup(command, family)
      expect(startup.env).toEqual({ ORCA_AUTOMATION_COMMAND: command })
      expect(startup.command).not.toContain(command)
      expect(startup.launchAgent).toBeUndefined()
      expect(startup.launchConfig).toBeUndefined()
    }
  )
})
