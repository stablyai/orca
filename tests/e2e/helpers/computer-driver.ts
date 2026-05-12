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

export type CliResult = {
  stdout: string
  stderr: string
}

export async function runOrcaCli(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/orca-dev')
  const command = process.env.ORCA_COMPUTER_CLI ?? devCli
  const cliArgs = process.env.ORCA_COMPUTER_CLI ? args : args
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
  const filePath = join(windowsTempDir, 'notepad-target.txt')
  await writeFile(filePath, 'seed', 'utf8')
  notepadProcess = spawn('notepad.exe', [filePath], { detached: true, stdio: 'ignore' })
  notepadProcess.unref()
  await delay(2500)
}

export async function killNotepad(): Promise<void> {
  if (notepadProcess?.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(notepadProcess.pid), '/T', '/F'])
    } catch {
      // The test-owned Notepad process may already be closed.
    }
    notepadProcess = null
  }
  if (windowsTempDir) {
    await rm(windowsTempDir, { force: true, recursive: true })
    windowsTempDir = null
  }
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
