import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { RmOptions } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../../../src/cli/runtime/client'
import { decodePairingOffer } from '../../../../../src/shared/remote-runtime/pairing/pairing'
import { getE2ECompletedOnboardingProfile } from '../../../desktop/electron-fixtures/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from '../../../desktop/electron-fixtures/electron-launch-args'
import {
  cleanupE2EDaemons,
  closeElectronAppForE2E,
  stopServeElectronAppForE2E
} from '../../../desktop/electron-fixtures/electron-process-shutdown'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from '../../../desktop/electron-fixtures/electron-home-isolation'
import type { RuntimeDesktopPairingOffer } from './paired-electron-client'
import { readPairingOffer, readServeReadiness } from './headless-paired-runtime-serve-readiness'
import { retryTransientMainEvaluate } from '../../../desktop/electron-fixtures/electron-main-evaluate-retry'
import { observeHeadlessPairedRuntimeProcessExit } from './headless-paired-runtime-process-exit'

export type HeadlessPairedRuntimeHost = {
  /** Current serve process. Replaced by `restartServeProcess`, so always read it fresh. */
  readonly app: ElectronApplication
  client: RuntimeClient
  dispose: () => Promise<void>
  offer: RuntimeDesktopPairingOffer
  // Reuse profile, pairing keys and port on serve restart; requires pinnedServePort to preserve existing client identity.
  restartServeProcess: (options?: {
    // Edit only between processes: the old host flushes on quit and the replacement reads on startup.
    betweenProcesses?: () => void | Promise<void>
  }) => Promise<void>
  userDataDir: string
  /** The isolated launch environment, for another host started on the same profile. */
  env: NodeJS.ProcessEnv
  /** Electron's own argv for this serve host, without the serve flags. */
  electronArgs: string[]
}

type HeadlessHostCleanup = () => Promise<void> | void

// Why: Windows keeps a just-killed daemon's handles on the profile briefly, so removal sees EPERM.
const PROFILE_REMOVAL: RmOptions = { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }

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

export async function launchHeadlessPairedRuntimeHost(
  options: {
    agentBrowserSocketParent?: string
    executablePath?: string
    /** Host-only env seams (e.g. a forced-unavailable snapshot) the paired client must not inherit. */
    extraEnv?: Record<string, string>
    // Mobile scope creates the host’s only offer; desktop plus direct-phone pairing is unsupported.
    pairingScope?: 'runtime' | 'mobile'
    /** Bind a stable loopback port so `restartServeProcess` can reclaim it. */
    pinnedServePort?: boolean
    userDataParent?: string
    /** No browser of its own, as the WSL distro's server: its browser tabs live only on clients. */
    withoutBrowser?: boolean
  } = {}
): Promise<HeadlessPairedRuntimeHost> {
  const userDataDir = mkdtempSync(
    path.join(options.userDataParent ?? os.tmpdir(), 'orca-e2e-headless-paired-')
  )
  let servePort = 0
  let agentBrowserSocketDir: string | null = null
  let app: ElectronApplication | undefined
  let stopProcessDiagnostics: (() => void) | undefined
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
        ORCA_E2E_HEADLESS: '1',
        ...(options.withoutBrowser ? { ORCA_E2E_HEADLESS_SERVE_WITHOUT_BROWSER: '1' } : {})
      },
      extraEnv: options.extraEnv ?? {},
      userDataDir
    })
    if (agentBrowserSocketDir) {
      isolation.env.AGENT_BROWSER_SOCKET_DIR = agentBrowserSocketDir
    }
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const launchServeProcess = async (): Promise<ElectronApplication> => {
      const launched = await electron.launch({
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
        args: [
          ...(options.executablePath ? [] : getOrcaElectronLaunchArgs(mainPath, false)),
          '--serve',
          '--serve-json',
          '--serve-port',
          String(servePort),
          '--serve-pairing-address',
          '127.0.0.1',
          ...(options.pairingScope === 'mobile' ? ['--serve-mobile-pairing'] : [])
        ],
        env: isolation.env
      })
      stopProcessDiagnostics = observeHeadlessPairedRuntimeProcessExit(launched)
      return launched
    }
    const launchedApp = await launchServeProcess()
    app = launchedApp
    const [offer] = await Promise.all([
      readPairingOffer(launchedApp),
      retryTransientMainEvaluate(() =>
        launchedApp.evaluate(({ app: electronApp }) => electronApp.getPath('home'))
      ).then((home) => assertElectronResolvedIsolatedHome(home, isolation))
    ])
    if (options.pinnedServePort === true) {
      const endpoint = new URL(decodePairingOffer(offer.pairingUrl).endpoint)
      const port = Number(endpoint.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('Headless runtime pairing offer did not publish its bound port')
      }
      servePort = port
    }
    let serveProcess = launchedApp
    // Do not re-close an app after failed relaunch or disposal can replace the launch error.
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
        stopProcessDiagnostics?.()
        await stopServeElectronAppForE2E(serveProcess)
        serveProcessOpen = false
        await restartOptions.betweenProcesses?.()
        const relaunched = await launchServeProcess()
        serveProcess = relaunched
        serveProcessOpen = true
        await readServeReadiness(relaunched, { requirePairingOffer: false })
      },
      dispose: async () => {
        const socketDir = agentBrowserSocketDir
        await cleanupHeadlessHostResources([
          () => stopProcessDiagnostics?.(),
          ...(serveProcessOpen
            ? [
                () =>
                  closeElectronAppForE2E(serveProcess, {
                    cleanupDaemonsForUserDataDir: userDataDir
                  })
              ]
            : []),
          () => cleanupE2EDaemons(userDataDir),
          () => preserveProfileLogs(userDataDir),
          () => rmSync(userDataDir, PROFILE_REMOVAL),
          ...(socketDir
            ? [
                () =>
                  rmSync(socketDir, {
                    recursive: true,
                    force: true
                  })
              ]
            : [])
        ])
      }
    }
  } catch (error) {
    const launchedApp = app
    const socketDir = agentBrowserSocketDir
    try {
      await cleanupHeadlessHostResources([
        () => stopProcessDiagnostics?.(),
        ...(launchedApp
          ? [
              () =>
                closeElectronAppForE2E(launchedApp, { cleanupDaemonsForUserDataDir: userDataDir })
            ]
          : []),
        () => cleanupE2EDaemons(userDataDir),
        () => preserveProfileLogs(userDataDir),
        () => rmSync(userDataDir, PROFILE_REMOVAL),
        ...(socketDir ? [() => rmSync(socketDir, { recursive: true, force: true })] : [])
      ])
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Headless runtime startup and cleanup failed')
    }
    throw error
  }
}
