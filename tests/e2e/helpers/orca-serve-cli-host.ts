/**
 * `orca serve` through the real CLI (`out/cli/index.js`), so the host it picks is the CLI's own
 * selection: orcad by default, Electron on `ORCA_SERVE_RUNTIME=electron` or a fallback.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { createElectronHomeIsolation } from './electron-home-isolation'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { resolveElectronExecutable } from './daemon-generation-runtime-fixture'

export type CliServe = {
  userDataDir: string
  /** The first stdout line: the chosen host's readiness JSON. */
  readiness: Record<string, unknown>
  stderr: () => string
  stop: () => Promise<void>
}

/** Writes the onboarded profile into `userDataDir` and isolates the launch home around it. */
export function isolatedServeProfile(
  userDataDir: string,
  launchEnv: NodeJS.ProcessEnv
): ReturnType<typeof createElectronHomeIsolation> {
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  return createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv,
    extraEnv: {},
    userDataDir
  })
}

/** A fresh isolated profile the CLI and whichever host it starts both use. */
export function cliServeProfile(parent: string): { userDataDir: string; env: NodeJS.ProcessEnv } {
  const userDataDir = mkdtempSync(path.join(parent, 'cli-serve-'))
  // The lock flag makes e2e builds take the profile lock this test reads, as the host helper does.
  const isolation = isolatedServeProfile(userDataDir, {
    NODE_ENV: 'development',
    ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1',
    ORCA_E2E_HEADLESS: '1'
  })
  return {
    userDataDir,
    env: {
      ...isolation.env,
      // How `orca serve` from a dev checkout finds its app (config/scripts/orca-dev.mjs).
      ORCA_APP_EXECUTABLE: resolveElectronExecutable(process.cwd()),
      ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: '1',
      ORCA_USER_DATA_PATH: userDataDir
    }
  }
}

export type ReadyProcess<T> = {
  ready: T
  stderr: () => string
  /** SIGTERM, then waits for exit. */
  stop: () => Promise<void>
}

/** Spawns a serve process and resolves once `parseReady` finds readiness in its stdout. */
export async function spawnUntilReady<T>(options: {
  label: string
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  parseReady: (stdout: string) => T | null
}): Promise<ReadyProcess<T>> {
  const child = spawnProcess({
    program: options.program,
    args: options.args,
    env: options.env,
    timeoutMs: null
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = new Promise((settle) => child.once('exit', settle))
    child.kill('SIGTERM')
    await exited
  }
  const ready = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Why stop first: a leaked host keeps the profile lock and daemon for the rest of the suite.
      void stop().finally(() => reject(new Error(`${options.label} not ready: ${stderr}`)))
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const parsed = options.parseReady(stdout)
      if (parsed !== null) {
        clearTimeout(timer)
        resolve(parsed)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${options.label} exited ${String(code)}: ${stderr}`))
    })
  })
  return { ready, stderr: () => stderr, stop }
}

export async function startCliServe(
  profile: { userDataDir: string; env: NodeJS.ProcessEnv },
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<CliServe> {
  const stopHost = async (): Promise<void> => {
    if (process.platform === 'win32') {
      await killProfileLockHolder(profile.userDataDir)
    }
  }
  const serve = await spawnUntilReady({
    label: 'orca serve',
    program: process.execPath,
    args: [
      path.join(process.cwd(), 'out', 'cli', 'index.js'),
      'serve',
      '--json',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1'
    ],
    env: { ...profile.env, ...extraEnv },
    // A first run may fetch and verify the pinned Node before orcad starts.
    timeoutMs: 240_000,
    parseReady: parseReadiness
  }).catch(async (error: unknown) => {
    await stopHost()
    throw error
  })
  return {
    userDataDir: profile.userDataDir,
    readiness: serve.ready,
    stderr: serve.stderr,
    stop: async () => {
      // POSIX: the CLI forwards SIGTERM to the host it started. Windows has no signal to forward:
      // kill() ends only the CLI, so the host holding the profile lock is ended too.
      await serve.stop()
      await stopHost()
    }
  }
}

/** orcad prints its readiness on one line; Electron `--serve-json` pretty-prints it. */
function parseReadiness(stdout: string): Record<string, unknown> | null {
  const start = stdout.indexOf('{')
  for (
    let end = stdout.indexOf('}', start);
    start !== -1 && end !== -1;
    end = stdout.indexOf('}', end + 1)
  ) {
    try {
      const parsed: unknown = JSON.parse(stdout.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed))
      }
    } catch {
      // Not a complete object yet; try the next closing brace.
    }
  }
  return null
}

async function killProfileLockHolder(userDataDir: string): Promise<void> {
  let pid: unknown
  try {
    pid = JSON.parse(readFileSync(path.join(userDataDir, 'orcad.lock'), 'utf8')).pid
  } catch {
    return
  }
  if (typeof pid !== 'number') {
    return
  }
  try {
    process.kill(pid)
  } catch {
    return
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((settle) => setTimeout(settle, 100))
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
