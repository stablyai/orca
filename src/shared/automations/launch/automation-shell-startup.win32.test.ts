import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { buildAutomationShellStartup } from './automation-shell-startup'
import { createAutomationShellReceiptScanner } from './automation-shell-exit-receipt'

describe.skipIf(process.platform !== 'win32').each(['off', 'on'])(
  'native CMD automation receipt with parent delayed expansion %s',
  (delayedExpansion) => {
    it.each([
      { command: 'exit /b 0', expected: 0 },
      { command: 'exit /b 7', expected: 7 },
      { command: 'orca_nonexistent_automation_command', expected: 1 },
      { command: 'cmd.exe /d /c exit 7 & echo recovered', expected: 0 },
      { command: 'echo literal!value! & exit /b 0', expected: 0, output: 'literal!value!' },
      {
        command: `"${process.execPath}" -e "process.stdout.write('quoted path works'); process.exit(7)"`,
        expected: 7,
        output: 'quoted path works'
      }
    ])('preserves output and exit status: $command', async ({ command, expected, output }) => {
      const direct = await runProcess({
        program: 'cmd.exe',
        args: ['/d', '/v:off', '/s', '/c', `"${command}"`],
        windowsVerbatimArguments: true,
        timeoutMs: 15_000
      })
      const startup = buildAutomationShellStartup(command, 'cmd', 'native-cmd-run')
      const result = await runProcess({
        program: 'cmd.exe',
        args: ['/d', `/v:${delayedExpansion}`, '/s', '/c', `"${startup.command}"`],
        windowsVerbatimArguments: true,
        env: { ...process.env, ...startup.env },
        timeoutMs: 15_000
      })
      const receipts: number[] = []
      createAutomationShellReceiptScanner('native-cmd-run', (code) => receipts.push(code)).scan(
        result.stdout
      )
      expect(result.timedOut).toBe(false)
      expect(direct.timedOut).toBe(false)
      expect(result.code).toBe(direct.code)
      expect(result.code).toBe(expected)
      expect(receipts).toEqual([expected])
      if (output) {
        expect(result.stdout).toContain(output)
      }
    })
  }
)
