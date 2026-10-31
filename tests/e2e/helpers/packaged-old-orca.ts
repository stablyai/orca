// Use the pinned packaged build named by ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE; skip when it is unavailable.
import { assertMacGuiLaunchAllowed } from '../../../config/scripts/macos-gui-launch-preflight.mjs'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { forwardElectronProcessLogs } from './orca-app'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './electron-home-isolation'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'
import type { OrcaCliResult } from './compiled-orca-cli'
import { isolatedServeProfile, spawnUntilReady, type ReadyProcess } from './orca-serve-cli-host'
import {
  isHeadlessPairedRuntimeServeReadyLine,
  parseHeadlessPairedRuntimePairingOffer
} from './headless-paired-runtime-serve-readiness'
import { RuntimeClient } from '../../../src/cli/runtime/client'

export const PACKAGED_EXECUTABLE_ENV = 'ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE'

export const packagedExecutable = process.env[PACKAGED_EXECUTABLE_ENV]

export const packagedExecutableMissing = !packagedExecutable || !existsSync(packagedExecutable)

export type PackagedPairedClient = {
  app: ElectronApplication
  environmentId: string
  page: Page
  status: { capabilities: string[] }
  version: string
  dispose(): Promise<void>
}

type Cleanup = () => Promise<void> | void

export async function collectCleanupFailures(cleanups: Cleanup[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function removeProfile(userDataDir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
}

/** The packaged desktop, hidden, paired to `offer` through its own Settings call. */
export async function launchPackagedPairedClient(args: {
  executablePath: string
  offer: RuntimeDesktopPairingOffer
  testInfo: TestInfo
  name?: string
}): Promise<PackagedPairedClient> {
  assertMacGuiLaunchAllowed()
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-packaged-client-'))
  let app: ElectronApplication | undefined
  try {
    const profile = getE2ECompletedOnboardingProfile()
    // A released build exposes no terminal handle; the DOM renderer leaves drawn rows as text.
    const settings = { ...profile.settings, terminalGpuAcceleration: 'off' }
    writeFileSync(
      path.join(userDataDir, 'orca-data.json'),
      `${JSON.stringify({ ...profile, settings }, null, 2)}\n`
    )
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const homeIsolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv: {},
      extraEnv: {},
      userDataDir
    })
    app = await electron.launch({
      executablePath: args.executablePath,
      args: [],
      env: {
        ...homeIsolation.env,
        NODE_ENV: 'production',
        ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
        ORCA_E2E_HEADLESS: '1'
      }
    })
    forwardElectronProcessLogs(app, args.testInfo)
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      homeIsolation
    )
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    const [status, version, environmentId] = await Promise.all([
      page.evaluate(() => window.api.runtime.getStatus()),
      app.evaluate(({ app: electronApp }) => electronApp.getVersion()),
      page.evaluate(
        async ({ pairingUrl, name }) => {
          const result = await window.api.runtimeEnvironments.addFromPairingCode({
            name,
            pairingCode: pairingUrl
          })
          const response = await window.api.runtimeEnvironments.getStatus({
            selector: result.environment.id,
            timeoutMs: 30_000
          })
          if (!response.ok) {
            throw new Error(`${response.error.code}: ${response.error.message}`)
          }
          return result.environment.id
        },
        { pairingUrl: args.offer.pairingUrl, name: args.name ?? 'packaged old client' }
      )
    ])
    // A capability check against a missing list would pass vacuously.
    if (!status.capabilities) {
      throw new Error(`packaged Orca ${version} reported no runtime capabilities`)
    }
    const launched = app
    return {
      app: launched,
      environmentId,
      page,
      status: { capabilities: status.capabilities },
      version,
      dispose: async () => {
        const failures = await collectCleanupFailures([
          () => closeElectronAppForE2E(launched),
          () => cleanupE2EDaemons(userDataDir),
          () => removeProfile(userDataDir)
        ])
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Failed to clean up packaged paired client')
        }
      }
    }
  } catch (error) {
    const cleanupErrors = await collectCleanupFailures([
      ...(app ? [() => closeElectronAppForE2E(app!)] : []),
      () => cleanupE2EDaemons(userDataDir),
      () => removeProfile(userDataDir)
    ])
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Packaged client startup and cleanup failed'
      )
    }
    throw error
  }
}

/** The packaged build's bundled CLI entry, run the way its `bin/orca` launcher runs it. */
function packagedCliEntry(executablePath: string): string {
  const resources =
    process.platform === 'darwin'
      ? path.join(path.dirname(executablePath), '..', 'Resources')
      : path.join(path.dirname(executablePath), 'resources')
  return path.join(resources, 'app.asar.unpacked', 'out', 'cli', 'index.js')
}

/** The packaged build's own CLI against the runtime whose profile is `userDataDir`. */
export async function runPackagedOrcaCli(
  executablePath: string,
  userDataDir: string,
  args: string[],
  timeoutMs = 120_000
): Promise<OrcaCliResult> {
  const result = await runProcess({
    program: executablePath,
    args: [packagedCliEntry(executablePath), ...args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_USER_DATA_PATH: userDataDir },
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024
  })
  let json: OrcaCliResult['json'] = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { args, code: result.code, stdout: result.stdout, stderr: result.stderr, json }
}

export type PackagedServeHost = {
  offer: RuntimeDesktopPairingOffer
  client: RuntimeClient
  userDataDir: string
  /** Stops serve (SIGTERM) and starts it again on the same profile and port. */
  restart: () => Promise<void>
  dispose: () => Promise<void>
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => resolve())
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a TCP listen on a host address reports an AddressInfo.
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

// Spawn directly to capture readiness from process creation; Playwright can consume it before launch resolves.
export async function launchPackagedServeHost(executablePath: string): Promise<PackagedServeHost> {
  // Why /tmp on macOS: the released helper has a 103-byte Unix socket ceiling.
  const parent = process.platform === 'darwin' ? '/tmp' : os.tmpdir()
  const userDataDir = mkdtempSync(path.join(parent, 'orca-e2e-packaged-serve-'))
  const { env } = isolatedServeProfile(userDataDir, {
    NODE_ENV: 'production',
    ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1',
    ORCA_E2E_HEADLESS: '1'
  })
  const port = await reserveLoopbackPort()
  const launch = <T>(parseLine: (line: string) => T | null): Promise<ReadyProcess<T>> =>
    spawnUntilReady({
      label: 'packaged orca serve',
      program: executablePath,
      args: [
        // Raw spawn needs --no-sandbox because extracted Linux chrome-sandbox lacks root ownership.
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--serve',
        '--serve-json',
        '--serve-port',
        String(port),
        '--serve-pairing-address',
        '127.0.0.1'
      ],
      env,
      timeoutMs: 120_000,
      parseReady: (stdout) => {
        for (const line of stdout.split('\n')) {
          const parsed = parseLine(line)
          if (parsed !== null) {
            return parsed
          }
        }
        return null
      }
    })
  let serve: ReadyProcess<unknown> | null = null
  const cleanup = async (): Promise<void> => {
    const failures = await collectCleanupFailures([
      () => serve?.stop(),
      () => cleanupE2EDaemons(userDataDir),
      () => removeProfile(userDataDir)
    ])
    serve = null
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to clean up packaged serve host')
    }
  }
  try {
    const first = await launch(parseHeadlessPairedRuntimePairingOffer)
    serve = first
    return {
      offer: first.ready,
      client: new RuntimeClient(userDataDir, 30_000),
      userDataDir,
      restart: async () => {
        await serve?.stop()
        serve = null
        serve = await launch((line) => (isHeadlessPairedRuntimeServeReadyLine(line) ? true : null))
      },
      dispose: cleanup
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
