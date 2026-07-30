import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

type ServeReady = {
  type?: unknown
  pairing?: {
    available?: unknown
    url?: unknown
    webClientUrl?: unknown
  }
}

export type HeadlessPairedRuntimeHost = {
  app: ElectronApplication
  client: RuntimeClient
  dispose: () => Promise<void>
  offer: RuntimeDesktopPairingOffer
}

async function readPairingOffer(app: ElectronApplication): Promise<RuntimeDesktopPairingOffer> {
  const child = app.process()
  const stdout = child.stdout
  if (!stdout) {
    throw new Error('Headless runtime stdout is unavailable')
  }
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Headless runtime did not publish pairing readiness'))
    }, 60_000)
    const cleanup = (): void => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('close', onClose)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(
        new Error(
          `Headless runtime exited before pairing readiness (code=${code ?? 'none'}, signal=${signal ?? 'none'})`
        )
      )
    }
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString()
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        let readiness: ServeReady
        try {
          readiness = JSON.parse(line) as ServeReady
        } catch {
          continue
        }
        const pairing = readiness.pairing
        if (
          readiness.type !== 'orca_server_ready' ||
          pairing?.available !== true ||
          typeof pairing.url !== 'string' ||
          typeof pairing.webClientUrl !== 'string'
        ) {
          continue
        }
        cleanup()
        resolve({ pairingUrl: pairing.url, webClientUrl: pairing.webClientUrl })
        return
      }
    }
    stdout.on('data', onData)
    child.on('close', onClose)
    if (child.exitCode !== null || child.signalCode !== null) {
      onClose(child.exitCode, child.signalCode)
    }
  })
}

export async function launchHeadlessPairedRuntimeHost(): Promise<HeadlessPairedRuntimeHost> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-headless-paired-'))
  let app: ElectronApplication | undefined
  try {
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
      userDataDir,
      codexRealHomeEnabled: false
    })
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    app = await electron.launch({
      args: [
        ...getOrcaElectronLaunchArgs(mainPath, false),
        '--serve',
        '--serve-json',
        '--serve-port',
        '0',
        '--serve-pairing-address',
        '127.0.0.1'
      ],
      env: isolation.env
    })
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      isolation
    )
    const offer = await readPairingOffer(app)
    return {
      app,
      client: new RuntimeClient(userDataDir, 5_000),
      offer,
      dispose: async () => {
        await closeElectronAppForE2E(app)
        await cleanupE2EDaemons(userDataDir)
        rmSync(userDataDir, { recursive: true, force: true })
      }
    }
  } catch (error) {
    try {
      if (app) {
        await closeElectronAppForE2E(app)
      }
      await cleanupE2EDaemons(userDataDir)
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
    throw error
  }
}
