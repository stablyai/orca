import { execFile, spawn, type ChildProcess } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
let textEditTempDir: string | null = null
let linuxTempDir: string | null = null
let windowsTempDir: string | null = null
let geditProcess: ChildProcess | null = null
let notepadProcess: ChildProcess | null = null
let notepadAppSelector: string | null = null

export type CliResult = {
  stdout: string
  stderr: string
}

export async function runOrcaCli(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/orca-dev')
  const builtCli = join(process.cwd(), 'out/cli/index.js')
  const command =
    process.env.ORCA_COMPUTER_CLI ?? (process.platform === 'win32' ? process.execPath : devCli)
  const cliArgs = process.env.ORCA_COMPUTER_CLI
    ? args
    : process.platform === 'win32'
      ? [builtCli, ...args]
      : args
  try {
    const result = await execFileAsync(command, cliArgs, {
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureTextEditLaunched(): Promise<void> {
  await killTextEdit()
  textEditTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-e2e-'))
  const filePath = join(textEditTempDir, 'textedit-target.txt')
  await writeFile(filePath, 'seed', 'utf8')
  await execFileAsync('open', ['-a', 'TextEdit', '-n', filePath])
  await delay(5500)
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

export async function ensureGeditLaunched(): Promise<void> {
  await killGedit()
  linuxTempDir = await mkdtemp(join(tmpdir(), 'orca-computer-linux-e2e-'))
  const filePath = join(linuxTempDir, 'gedit-target.txt')
  await writeFile(filePath, 'seed', 'utf8')
  geditProcess = spawn('gedit', [filePath], { detached: true, stdio: 'ignore' })
  geditProcess.unref()
  await delay(3500)
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

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
