import { execFile, spawn, type ChildProcess } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import {
  ensureOrcaRuntimeLaunched,
  parseJsonOutput,
  runOrcaCli,
  stopOrcaRuntime,
  type CliResult
} from './computer-cli-driver'

const execFileAsync = promisify(execFile)
let textEditTempDir: string | null = null
let safariDraftTempDir: string | null = null
let safariDraftTitle: string | null = null
let linuxTempDir: string | null = null
let windowsTempDir: string | null = null
let geditProcess: ChildProcess | null = null
let notepadProcess: ChildProcess | null = null
let notepadAppSelector: string | null = null

export { ensureOrcaRuntimeLaunched, parseJsonOutput, runOrcaCli, stopOrcaRuntime, type CliResult }

export async function ensureTextEditLaunched(): Promise<void> {
  await killTextEdit()
  textEditTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-e2e-'))
  const filePath = join(textEditTempDir, 'textedit-target.txt')
  await writeFile(filePath, 'seed', 'utf8')
  await execFileAsync('open', ['-F', '-a', 'TextEdit', '-n', filePath])
  // Why: cold CI/user launches can register the process before System Events
  // exposes its first window; short waits make the live computer-use proof flaky.
  await waitForMacAppWindow('TextEdit', 15000)
}

export async function killTextEdit(): Promise<void> {
  try {
    await execFileAsync('killall', ['TextEdit'])
  } catch {
    // TextEdit may already be closed by the user or the OS.
  }
  if (textEditTempDir) {
    await rm(textEditTempDir, { force: true, recursive: true })
    textEditTempDir = null
  }
}

export type SafariDraftFixture = {
  title: string
}

export async function ensureSafariDraftFixtureLaunched(): Promise<SafariDraftFixture> {
  await closeSafariDraftFixture()
  safariDraftTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-safari-e2e-'))
  safariDraftTitle = `Orca Computer Use Draft Fixture ${Date.now()}`
  const filePath = join(safariDraftTempDir, 'index.html')
  await writeFile(filePath, safariDraftFixtureHtml(safariDraftTitle), 'utf8')
  await execFileAsync('open', ['-F', '-a', 'Safari', filePath])
  await waitForMacAppWindow('Safari', 15000)
  await waitForComputerWindowTitle('com.apple.Safari', safariDraftTitle, 15000)
  return { title: safariDraftTitle }
}

export async function closeSafariDraftFixture(): Promise<void> {
  const title = safariDraftTitle
  if (title) {
    try {
      const envelope = parseJsonOutput<{
        result: {
          windows: { id?: number | null; index: number; title: string }[]
        }
      }>(
        (await runOrcaCli(['computer', 'list-windows', '--app', 'com.apple.Safari', '--json']))
          .stdout
      )
      const target = envelope.result.windows.find((window) => window.title.includes(title))
      if (target) {
        const targetArgs =
          target.id !== undefined && target.id !== null
            ? ['--window-id', String(target.id)]
            : ['--window-index', String(target.index)]
        await runOrcaCli([
          'computer',
          'hotkey',
          '--app',
          'com.apple.Safari',
          ...targetArgs,
          '--key',
          'CmdOrCtrl+W',
          '--restore-window',
          '--no-screenshot',
          '--json'
        ])
      }
    } catch {
      // The test-owned Safari tab may already be closed or the runtime may be gone.
    }
    safariDraftTitle = null
  }
  if (safariDraftTempDir) {
    await rm(safariDraftTempDir, { force: true, recursive: true })
    safariDraftTempDir = null
  }
}

export async function activateFinder(): Promise<void> {
  await execFileAsync('open', ['-a', 'Finder'])
  await delay(1000)
}

async function waitForMacAppWindow(appName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync('osascript', [
        '-e',
        `tell application "System Events" to tell process "${escapeAppleScript(appName)}" to count windows`
      ])
      if (Number.parseInt(result.stdout.trim(), 10) > 0) {
        return
      }
    } catch {
      // The app process may not have registered with System Events yet.
    }
    await delay(250)
  }
  throw new Error(`${appName} did not expose a visible window within ${timeoutMs}ms`)
}

async function waitForComputerWindowTitle(
  app: string,
  title: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const envelope = parseJsonOutput<{
        result: { windows: { title: string }[] }
      }>((await runOrcaCli(['computer', 'list-windows', '--app', app, '--json'])).stdout)
      if (envelope.result.windows.some((window) => window.title.includes(title))) {
        return
      }
    } catch {
      // The browser window may not be visible to the provider yet.
    }
    await delay(250)
  }
  throw new Error(`${app} did not expose a window titled ${title} within ${timeoutMs}ms`)
}

export async function ensureGeditLaunched(): Promise<void> {
  await killGedit()
  linuxTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-linux-e2e-'))
  const fileName = 'gedit-target.txt'
  const filePath = join(linuxTempDir, fileName)
  await writeFile(filePath, 'seed', 'utf8')
  geditProcess = spawn('gedit', [filePath], { detached: true, stdio: 'ignore' })
  geditProcess.unref()
  await waitForComputerWindowTitle('gedit', fileName, 15000)
}

export async function killGedit(): Promise<void> {
  if (geditProcess?.pid) {
    try {
      process.kill(-geditProcess.pid, 'SIGTERM')
    } catch {
      // The test-owned gedit process may already be closed.
    }
    geditProcess = null
  }
  if (linuxTempDir) {
    await rm(linuxTempDir, { force: true, recursive: true })
    linuxTempDir = null
  }
}

export async function ensureNotepadLaunched(): Promise<void> {
  await killNotepad()
  windowsTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-windows-e2e-'))
  const filePath = join(windowsTempDir, `orca-notepad-${Date.now()}.txt`)
  await writeFile(filePath, 'seed', 'utf8')
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process notepad.exe -ArgumentList ${powerShellSingleQuoted(filePath)}`
  ])
  notepadAppSelector = `pid:${await findNotepadWindowPid(filePath)}`
}

export async function killNotepad(): Promise<void> {
  const notepadPid = notepadAppSelector?.startsWith('pid:')
    ? Number.parseInt(notepadAppSelector.slice(4), 10)
    : notepadProcess?.pid
  if (notepadPid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(notepadPid), '/T', '/F'])
    } catch {
      // The test-owned Notepad process may already be closed.
    }
    notepadProcess = null
    notepadAppSelector = null
  }
  if (windowsTempDir) {
    await rm(windowsTempDir, { force: true, recursive: true })
    windowsTempDir = null
  }
}

export function getNotepadAppSelector(): string {
  if (!notepadAppSelector) {
    throw new Error('Notepad has not been launched')
  }
  return notepadAppSelector
}

export function findRoleIndex(treeText: string, role: string | RegExp): number {
  const matcher =
    typeof role === 'string'
      ? new RegExp(`^\\s*(\\d+)\\s+${escapeRegExp(role)}(?:\\s|$)`, 'm')
      : role
  const match = treeText.match(matcher)
  return match?.[1] ? Number.parseInt(match[1], 10) : -1
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findNotepadWindowPid(filePath: string): Promise<number> {
  const targetName = filePath.split(/[\\/]/).at(-1) ?? filePath
  const script = [
    `$targetName = ${powerShellSingleQuoted(targetName)}`,
    '$deadline = (Get-Date).AddSeconds(15)',
    '$target = $null',
    'while ((Get-Date) -lt $deadline -and $null -eq $target) {',
    '  Start-Sleep -Milliseconds 250',
    '  $target = Get-Process Notepad -ErrorAction SilentlyContinue |',
    '    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$targetName*" } |',
    '    Sort-Object StartTime -Descending |',
    '    Select-Object -First 1',
    '}',
    'if ($null -eq $target) {',
    '  $target = Get-Process Notepad -ErrorAction SilentlyContinue |',
    '    Where-Object { $_.MainWindowHandle -ne 0 } |',
    '    Sort-Object StartTime -Descending |',
    '    Select-Object -First 1',
    '}',
    'if ($null -eq $target) { throw "No visible Notepad window found for $targetName" }',
    'Write-Output $target.Id'
  ].join('\n')
  const result = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ])
  return Number.parseInt(result.stdout.trim(), 10)
}

function powerShellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function escapeAppleScript(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function safariDraftFixtureHtml(title: string): string {
  const escapedTitle = escapeHtml(title)
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    `<title>${escapedTitle}</title>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Draft Fixture</h1>',
    '<label>Recipient <input id="recipient" aria-label="Recipient"></label>',
    '<label>Body <textarea id="body" aria-label="Body"></textarea></label>',
    "<button id=\"save\" onclick=\"document.getElementById('status').textContent = 'Draft ready: ' + document.getElementById('recipient').value + ' / ' + document.getElementById('body').value\">Save draft</button>",
    '<p id="status" role="status">Draft empty</p>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
