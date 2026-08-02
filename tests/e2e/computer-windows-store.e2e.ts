import { describe, expect, test } from 'vitest'
import type { ComputerListAppsResult, ComputerSnapshotResult } from '../../src/shared/runtime-types'
import {
  ensureOrcaRuntimeLaunched,
  findRoleIndex,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime
} from './helpers/computer-driver'

const isWindows = process.platform === 'win32'
const e2eOptIn = process.env.ORCA_COMPUTER_E2E === '1'

describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows e2e (Store apps)', () => {
  test('Store app windows are discoverable by title and clickable', async () => {
    await ensureOrcaRuntimeLaunched()
    await launchCalculator()
    try {
      const apps = parseJsonOutput<{ result: ComputerListAppsResult }>(
        (await runOrcaCli(['computer', 'list-apps', '--json'])).stdout
      )
      expect(apps.result.apps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Calculator', bundleId: 'ApplicationFrameHost' })
        ])
      )

      let state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
        (
          await runOrcaCli([
            'computer',
            'get-app-state',
            '--app',
            'Calculator',
            '--no-screenshot',
            '--json'
          ])
        ).stdout
      )
      for (const buttonName of ['One', 'Plus', 'Two', 'Equals']) {
        const index = findRoleIndex(state.result.snapshot.treeText, `button ${buttonName}`)
        expect(index).toBeGreaterThanOrEqual(0)
        state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
          (
            await runOrcaCli([
              'computer',
              'click',
              '--app',
              'Calculator',
              '--element-index',
              String(index),
              '--no-screenshot',
              '--json'
            ])
          ).stdout
        )
      }
      expect(state.result.snapshot.treeText).toMatch(/Display is 3\b/)
    } finally {
      await killCalculator()
      await stopOrcaRuntime()
    }
  })
})

async function launchCalculator(): Promise<void> {
  await runPowerShell('Start-Process calc.exe')
  await runPowerShell(
    [
      '$deadline = (Get-Date).AddSeconds(15)',
      '$target = $null',
      'while ((Get-Date) -lt $deadline -and $null -eq $target) {',
      '  Start-Sleep -Milliseconds 250',
      '  $target = Get-Process |',
      '    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq "Calculator" } |',
      '    Select-Object -First 1',
      '}',
      'if ($null -eq $target) { throw "No visible Calculator window found" }'
    ].join('\n')
  )
}

async function killCalculator(): Promise<void> {
  // Why: teardown is best-effort so cleanup noise cannot mask assertion signal.
  await runPowerShell(
    [
      '$processes = @()',
      '$processes += Get-Process -Name CalculatorApp -ErrorAction SilentlyContinue',
      '$processes += Get-Process -Name ApplicationFrameHost -ErrorAction SilentlyContinue |',
      '  Where-Object { $_.MainWindowTitle -eq "Calculator" }',
      'foreach ($process in $processes) {',
      '  try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }',
      '}',
      'exit 0'
    ].join('\n')
  ).catch(() => undefined)
}

async function runPowerShell(script: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
