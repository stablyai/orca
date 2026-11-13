import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { quotePowerShellLiteral } from '../../../src/shared/powershell-native-argument'

export type WindowFixture = { pid: number; dir: string }

// Test-owned WinForms window; `onShown` runs on its UI thread once the window is visible.
export async function launchWindowFixture(formSetup: string, onShown = ''): Promise<WindowFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-computer-windows-fixture-'))
  const readyPath = join(dir, 'ready')
  const scriptPath = join(dir, 'fixture.ps1')
  // Why: Windows PowerShell 5.1 reads BOM-less scripts as ANSI, which corrupts non-ASCII temp paths.
  await writeFile(
    scriptPath,
    `\ufeff${[
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$form = New-Object System.Windows.Forms.Form',
      formSetup,
      `$form.Add_Shown({ $form.Refresh(); [IO.File]::WriteAllText(${quotePowerShellLiteral(readyPath)}, 'ready'); ${onShown} })`,
      '[System.Windows.Forms.Application]::Run($form)'
    ].join('\n')}`,
    'utf8'
  )
  const child = spawn(
    'powershell.exe',
    // Hide only the console, which would otherwise be the process's main window; windowsHide would hide the form too.
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath
    ],
    { stdio: 'ignore' }
  )
  if (!child.pid) {
    throw new Error('window fixture did not start')
  }
  const fixture = { pid: child.pid, dir }
  try {
    await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true), {
      timeout: 15_000,
      interval: 100
    })
  } catch (error) {
    await closeWindowFixture(fixture)
    throw error
  }
  return fixture
}

// A window whose UI thread stops pumping once shown. Win32 Sleep, because Start-Sleep waits on an STA
// handle that still answers sent messages.
export function launchHungWindowFixture(): Promise<WindowFixture> {
  return launchWindowFixture(
    [
      "$form.Text = 'orca-e2e-hung'",
      'Add-Type -Name Kernel -Namespace OrcaFixture -MemberDefinition \'[DllImport("kernel32.dll")] public static extern void Sleep(uint ms);\''
    ].join('\n'),
    '[OrcaFixture.Kernel]::Sleep(120000)'
  )
}

export async function closeWindowFixture(fixture: WindowFixture): Promise<void> {
  await new Promise<void>((resolve) => {
    spawn('taskkill.exe', ['/PID', String(fixture.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('exit', () => resolve())
      .on('error', () => resolve())
  })
  await rm(fixture.dir, { force: true, recursive: true })
}

export type ScreenRect = { x: number; y: number; width: number; height: number }

// Fraction of sampled pixels that are the cover's magenta, read from a PNG or from the live screen.
export async function countMagentaPixelRatio(source: string | ScreenRect): Promise<number> {
  const load =
    typeof source === 'string'
      ? `$bitmap = [System.Drawing.Bitmap]::FromFile(${quotePowerShellLiteral(source)})`
      : [
          `$bitmap = New-Object System.Drawing.Bitmap ${source.width}, ${source.height}`,
          '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
          `$graphics.CopyFromScreen(${source.x}, ${source.y}, 0, 0, $bitmap.Size)`,
          '$graphics.Dispose()'
        ].join('\n')
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    load,
    '$magenta = 0',
    'for ($y = 0; $y -lt $bitmap.Height; $y += 4) {',
    '  for ($x = 0; $x -lt $bitmap.Width; $x += 4) {',
    '    $pixel = $bitmap.GetPixel($x, $y)',
    '    if ($pixel.R -gt 240 -and $pixel.G -lt 16 -and $pixel.B -gt 240) { $magenta++ }',
    '  }',
    '}',
    '$samples = [Math]::Ceiling($bitmap.Width / 4) * [Math]::Ceiling($bitmap.Height / 4)',
    '$bitmap.Dispose()',
    'Write-Output "$magenta $samples"'
  ].join('\n')
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`pixel count exited ${code}`))
    )
  })
  const [magenta, samples] = output.trim().split(/\s+/).map(Number)
  return magenta / samples
}
