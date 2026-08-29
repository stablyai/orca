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

describe.skipIf(!isWindows || !e2eOptIn)('computer-use Windows e2e (Calculator)', () => {
  test('Calculator windows are discoverable by title and clickable', async () => {
    await ensureOrcaRuntimeLaunched()
    await launchCalculator()
    try {
      const apps = parseJsonOutput<{ result: ComputerListAppsResult }>(
        (await runOrcaCli(['computer', 'list-apps', '--json'])).stdout
      )
      // Windows 2025 hosts Calculator as win32calc; older images use ApplicationFrameHost.
      const calculatorApp = apps.result.apps.find(
        (app) =>
          (app.name === 'Calculator' && app.bundleId === 'ApplicationFrameHost') ||
          (app.name === 'win32calc' && app.bundleId === 'win32calc')
      )
      expect(calculatorApp).toMatchObject({ isRunning: true })

      const state = parseJsonOutput<{ result: ComputerSnapshotResult }>(
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
      const buttonIndex = findRoleIndex(
        state.result.snapshot.treeText,
        /^\s*(\d+)\s+button(?:\s|$)/m
      )
      // Classic Calculator exposes only pane nodes; clicking one still proves title routing.
      const clickIndex =
        buttonIndex >= 0
          ? buttonIndex
          : findRoleIndex(state.result.snapshot.treeText, /^\s*(\d+)\s+pane(?:\s|$)/m)
      expect(clickIndex, state.result.snapshot.treeText).toBeGreaterThanOrEqual(0)
      const clicked = parseJsonOutput<{ result: ComputerSnapshotResult }>(
        (
          await runOrcaCli([
            'computer',
            'click',
            '--app',
            'Calculator',
            '--element-index',
            String(clickIndex),
            '--no-screenshot',
            '--json'
          ])
        ).stdout
      )
      expect(clicked.result.snapshot.elementCount).toBeGreaterThan(0)
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
      '$processes += Get-Process -Name win32calc -ErrorAction SilentlyContinue',
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
