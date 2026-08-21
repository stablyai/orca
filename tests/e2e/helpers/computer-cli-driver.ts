import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createElectronHomeIsolation } from './electron-home-isolation'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'mcode-runtime.json'
let mcodeDevUserDataPath: string | null = null
let mcodeServeProcess: ChildProcess | null = null
let mcodeServeStdout = ''
let mcodeServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunMCodeCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runMCodeCli(
  args: string[],
  options: RunMCodeCliOptions = {}
): Promise<CliResult> {
  try {
    return await runMCodeCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensureMCodeRuntimeLaunched()
      return await runMCodeCliOnce(args)
    }
    throw error
  }
}

async function runMCodeCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/mcode-dev.mjs')
  const command = process.env.MCODE_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.MCODE_COMPUTER_CLI ? args : [devCli, ...args]
  const env = process.env.MCODE_COMPUTER_CLI
    ? { ...process.env }
    : await createComputerE2ERuntimeEnv()
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
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

export async function ensureMCodeRuntimeLaunched(): Promise<void> {
  if (!process.env.MCODE_COMPUTER_CLI && process.platform === 'win32') {
    await ensureMCodeRuntimeServed()
    return
  }
  await runMCodeCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForMCodeRuntimeReady()
}

export async function stopMCodeRuntime(): Promise<void> {
  const processToStop = mcodeServeProcess
  if (!processToStop?.pid) {
    return
  }
  mcodeServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eMCodeDevUserDataPath(): Promise<string> {
  if (!mcodeDevUserDataPath) {
    // Why: the shared mcode-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    mcodeDevUserDataPath = await mkdtemp(join(tmpdir(), 'mcode-computer-runtime-'))
  }
  return mcodeDevUserDataPath
}

async function waitForMCodeRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eMCodeDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runMCodeCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    mcodeServeStdout.trim() ? `serve stdout: ${mcodeServeStdout.trim()}` : null,
    mcodeServeStderr.trim() ? `serve stderr: ${mcodeServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`MCode runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureMCodeRuntimeServed(): Promise<void> {
  if (!mcodeServeProcess || mcodeServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/mcode-dev.mjs')
    const env = await createComputerE2ERuntimeEnv()
    mcodeServeStdout = ''
    mcodeServeStderr = ''
    mcodeServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    mcodeServeProcess.stdout?.on('data', (chunk) => {
      mcodeServeStdout += String(chunk)
    })
    mcodeServeProcess.stderr?.on('data', (chunk) => {
      mcodeServeStderr += String(chunk)
    })
    mcodeServeProcess.once('exit', () => {
      mcodeServeProcess = null
    })
    process.once('exit', () => {
      mcodeServeProcess?.kill()
    })
  }
  await waitForMCodeRuntimeReady()
}

async function createComputerE2ERuntimeEnv(): Promise<NodeJS.ProcessEnv> {
  const userDataDir =
    process.env.MCODE_DEV_USER_DATA_PATH ?? (await getComputerE2eMCodeDevUserDataPath())
  // Why: agent runtimes export ELECTRON_RUN_AS_NODE, which would make the
  // spawned Electron behave as plain Node; strip it like every other caller.
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...inheritedEnv } = process.env
  void _electronRunAsNode
  const isolation = createElectronHomeIsolation({
    inheritedEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  return {
    ...isolation.env,
    // Why: the Node CLI and the Electron child must resolve the same runtime
    // metadata while the E2E boundary owns their home and Codex paths.
    MCODE_DEV_USER_DATA_PATH: userDataDir
  }
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read MCode runtime metadata')
  )
}
