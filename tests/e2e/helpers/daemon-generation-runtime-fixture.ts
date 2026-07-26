import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import type { TestInfo } from '@playwright/test'

const TEMP_PREFIX = 'orca-9749-dg-'

type DiagnosticGeneration = {
  label: string
  protocolVersion: number
  identity: { pid: number }
  socketPath: string
  logEvents(): Record<string, unknown>[]
  startupLog(): string
}

export type DaemonGenerationRuntime = {
  rootDir: string
  userDataDir: string
  daemonDir: string
  entryPath: string
  reconnectClientEntryPath: string
  canaryPath: string
  electronPath: string
  retainDiagnostics(generations: readonly DiagnosticGeneration[]): void
  remove(): void
}

function normalizeForContainment(candidate: string): string {
  const normalized = path.resolve(candidate)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isEqualToOrInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeForContainment(candidate)
  const normalizedParent = normalizeForContainment(parent)
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`)
  )
}

function knownOrcaUserDataDirs(): string[] {
  if (process.platform === 'darwin') {
    const appSupport = path.join(homedir(), 'Library', 'Application Support')
    return [path.join(appSupport, 'orca'), path.join(appSupport, 'orca-dev')]
  }
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
    return [path.join(roaming, 'orca'), path.join(roaming, 'orca-dev')]
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
  return [path.join(config, 'orca'), path.join(config, 'orca-dev')]
}

function assertDisposableRoot(rootDir: string): void {
  const tempRoot = process.platform === 'darwin' ? path.join(path.sep, 'tmp') : tmpdir()
  if (!path.basename(rootDir).startsWith(TEMP_PREFIX)) {
    throw new Error('Refusing daemon-generation cleanup without its fixture prefix')
  }
  if (!isEqualToOrInside(rootDir, tempRoot)) {
    throw new Error('Daemon-generation fixture escaped the OS temporary directory')
  }
  for (const userDataDir of knownOrcaUserDataDirs()) {
    if (isEqualToOrInside(rootDir, userDataDir)) {
      throw new Error('Refusing daemon-generation fixture inside real Orca user data')
    }
  }
}

function resolveElectronExecutable(repoRoot: string): string {
  const relativePath = readFileSync(
    path.join(repoRoot, 'node_modules', 'electron', 'path.txt'),
    'utf8'
  ).trim()
  const executable = path.join(repoRoot, 'node_modules', 'electron', 'dist', relativePath)
  if (!existsSync(executable)) {
    throw new Error(`Local Electron executable is missing: ${executable}`)
  }
  return executable
}

async function buildFixtureEntry(entryPoint: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    packages: 'external',
    external: ['node-pty'],
    logLevel: 'silent'
  })
}

export async function createDaemonGenerationRuntime(
  testInfo: TestInfo
): Promise<DaemonGenerationRuntime> {
  const tempRoot = process.platform === 'darwin' ? path.join(path.sep, 'tmp') : tmpdir()
  const rootDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX))
  assertDisposableRoot(rootDir)
  const userDataDir = path.join(rootDir, 'user-data')
  const daemonDir = path.join(userDataDir, 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  const entryPath = path.join(rootDir, 'daemon-generation-entry.cjs')
  const reconnectClientEntryPath = path.join(rootDir, 'daemon-generation-reconnect-client.cjs')
  const repoRoot = process.cwd()
  await buildFixtureEntry(
    path.join(repoRoot, 'tests/e2e/fixtures/daemon-generation-entry.ts'),
    entryPath
  )
  await buildFixtureEntry(
    path.join(repoRoot, 'tests/e2e/fixtures/daemon-generation-reconnect-client.ts'),
    reconnectClientEntryPath
  )
  return {
    rootDir,
    userDataDir,
    daemonDir,
    entryPath,
    reconnectClientEntryPath,
    canaryPath: path.join(repoRoot, 'tests/e2e/fixtures/daemon-generation-canary.cjs'),
    electronPath: resolveElectronExecutable(repoRoot),
    retainDiagnostics: (generations) => {
      mkdirSync(testInfo.outputDir, { recursive: true })
      writeFileSync(
        testInfo.outputPath('daemon-generation-safety-diagnostics.json'),
        `${JSON.stringify(
          generations.map((generation) => ({
            label: generation.label,
            protocolVersion: generation.protocolVersion,
            pid: generation.identity.pid,
            socketPath: generation.socketPath,
            logEvents: generation.logEvents(),
            startupLog: generation.startupLog()
          })),
          null,
          2
        )}\n`
      )
    },
    remove: () => {
      assertDisposableRoot(rootDir)
      // Why: Windows can release ConPTY/log handles just after exact-PID
      // liveness reaches zero; keep fixture cleanup bounded but non-flaky.
      rmSync(rootDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
}
