import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './electron-home-isolation'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'
import { readPairingOffer, readServeReadiness } from './headless-paired-runtime-serve-readiness'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

export type HeadlessPairedRuntimeHost = {
  /** Current serve process. Replaced by `restartServeProcess`, so always read it fresh. */
  readonly app: ElectronApplication
  client: RuntimeClient
  dispose: () => Promise<void>
  offer: RuntimeDesktopPairingOffer
  /**
   * Quits the serve process and starts a new one on the same user-data directory,
   * pairing keys, and WebSocket port, so an already-paired client reconnects to the
   * same environment record without a fresh offer. Requires `pinnedServePort: true`.
   */
  restartServeProcess: (options?: {
    /**
     * Runs with no serve process alive, before the replacement launches. The only safe window to
     * edit the profile: the quitting process flushes its own state on the way out, and the
     * replacement reads the file at startup.
     */
    betweenProcesses?: () => void | Promise<void>
  }) => Promise<void>
  userDataDir: string
  /** The isolated launch environment, for another host started on the same profile. */
  env: NodeJS.ProcessEnv
  /** Electron's own argv for this serve host, without the serve flags. */
  electronArgs: string[]
}

type HeadlessHostCleanup = () => Promise<void> | void

/** CI diagnostics: the profile's logs outlive its deletion when this names a directory. */
function preserveProfileLogs(userDataDir: string): void {
  const target = process.env.ORCA_E2E_PRESERVE_PROFILE_LOGS_DIR
  const logs = path.join(userDataDir, 'logs')
  if (target && existsSync(logs)) {
    cpSync(logs, path.join(target, path.basename(userDataDir)), { recursive: true })
  }
}

async function cleanupHeadlessHostResources(cleanups: HeadlessHostCleanup[]): Promise<void> {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean up headless paired runtime host')
  }
}

/**
 * Loopback port that is free right now, so a serve process can be relaunched onto the
 * same endpoint an already-paired client recorded. `--serve-port 0` cannot: the kernel
 * hands the second process a different port and the paired client keeps dialing the old one.
 */
async function reserveFreeLoopbackPort(): Promise<number> {
  const probe = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        probe.off('error', reject)
        resolve()
      })
    })
    return (probe.address() as AddressInfo).port
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  }
}

export async function launchHeadlessPairedRuntimeHost(
  options: {
    agentBrowserSocketParent?: string
    executablePath?: string
    /** Bind a stable loopback port so `restartServeProcess` can reclaim it. */
    pinnedServePort?: boolean
    userDataParent?: string
  } = {}
): Promise<HeadlessPairedRuntimeHost> {
  const userDataDir = mkdtempSync(
    path.join(options.userDataParent ?? os.tmpdir(), 'orca-e2e-headless-paired-')
  )
  const servePort = options.pinnedServePort === true ? await reserveFreeLoopbackPort() : 0
  let agentBrowserSocketDir: string | null = null
  let app: ElectronApplication | undefined
  try {
    agentBrowserSocketDir = options.agentBrowserSocketParent
      ? mkdtempSync(path.join(options.agentBrowserSocketParent, 'orca-ab-'))
      : null
    writeFileSync(
      path.join(userDataDir, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const isolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv: {
        NODE_ENV: 'development',
        ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1',
        ORCA_E2E_HEADLESS: '1'
      },
      extraEnv: {},
      userDataDir
    })
    if (agentBrowserSocketDir) {
      isolation.env.AGENT_BROWSER_SOCKET_DIR = agentBrowserSocketDir
    }
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const launchServeProcess = (): Promise<ElectronApplication> =>
      electron.launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        args: [
          ...(options.executablePath ? [] : getOrcaElectronLaunchArgs(mainPath, false)),
          '--serve',
          '--serve-json',
          '--serve-port',
          String(servePort),
          '--serve-pairing-address',
          '127.0.0.1'
        ],
        env: isolation.env
      })
    app = await launchServeProcess()
    const [offer] = await Promise.all([
      readPairingOffer(app),
      retryTransientMainEvaluate(() =>
        app.evaluate(({ app: electronApp }) => electronApp.getPath('home'))
      ).then((home) => assertElectronResolvedIsolatedHome(home, isolation))
    ])
    let serveProcess = app
    // Why: a failed relaunch leaves only the already-closed app, which dispose must not close again
    // (that throw would replace the launch error).
    let serveProcessOpen = true
    return {
      get app() {
        return serveProcess
      },
      client: new RuntimeClient(userDataDir, 5_000),
      offer,
      userDataDir,
      env: isolation.env,
      electronArgs: options.executablePath ? [] : getOrcaElectronLaunchArgs(mainPath, false),
      restartServeProcess: async (restartOptions = {}) => {
        if (options.pinnedServePort !== true) {
          throw new Error(
            'restartServeProcess requires launchHeadlessPairedRuntimeHost({ pinnedServePort: true })'
          )
        }
        await closeElectronAppForE2E(serveProcess)
        serveProcessOpen = false
        await restartOptions.betweenProcesses?.()
        const relaunched = await launchServeProcess()
        serveProcess = relaunched
        serveProcessOpen = true
        await readServeReadiness(relaunched, { requirePairingOffer: false })
      },
      dispose: async () => {
        await cleanupHeadlessHostResources([
          ...(serveProcessOpen ? [() => closeElectronAppForE2E(serveProcess)] : []),
          () => cleanupE2EDaemons(userDataDir),
          () => preserveProfileLogs(userDataDir),
          () => rmSync(userDataDir, { recursive: true, force: true }),
          ...(agentBrowserSocketDir
            ? [
                () =>
                  rmSync(agentBrowserSocketDir, {
                    recursive: true,
                    force: true
                  })
              ]
            : [])
        ])
      }
    }
  } catch (error) {
    try {
      await cleanupHeadlessHostResources([
        ...(app ? [() => closeElectronAppForE2E(app)] : []),
        () => cleanupE2EDaemons(userDataDir),
        () => preserveProfileLogs(userDataDir),
        () => rmSync(userDataDir, { recursive: true, force: true }),
        ...(agentBrowserSocketDir
          ? [() => rmSync(agentBrowserSocketDir, { recursive: true, force: true })]
          : [])
      ])
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Headless runtime startup and cleanup failed')
    }
    throw error
  }
}
