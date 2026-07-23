import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'

import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import {
  assertElectronResolvedIsolatedHome,
  createElectronHomeIsolation
} from './electron-home-isolation'
import { forwardElectronProcessLogs } from './orca-app'
import {
  replaceRuntimePairingInPlace,
  type SameIdPairingReplacement
} from './nested-runtime-same-id-pairing'

export type { SameIdPairingReplacement } from './nested-runtime-same-id-pairing'

export type PairedElectronClient = {
  app: ElectronApplication
  page: Page
  environmentId: string
  captureDirectSshAttempts: () => Promise<void>
  dispose: () => Promise<void>
  getDirectSshAttemptTargetIds: () => Promise<string[]>
  installDirectSshAttemptProbe: () => Promise<void>
  replacePairingInPlace: (offer: RuntimeDesktopPairingOffer) => Promise<SameIdPairingReplacement>
}

export type RuntimeDesktopPairingOffer = {
  pairingUrl: string
  webClientUrl?: string
}

export type PairedWebClient = {
  page: Page
  dispose: () => Promise<void>
}

const DIRECT_SSH_PROBE_CANARY_TARGET_ID = '__orca_e2e_direct_ssh_probe_canary__'

function readDirectSshAttemptTargetIds(probePath: string): string[] {
  try {
    return readFileSync(probePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string)
  } catch {
    return []
  }
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

export async function createRuntimeDesktopPairingOffer(
  hubPage: Page
): Promise<RuntimeDesktopPairingOffer> {
  return hubPage.evaluate(async () => {
    const offer = await window.api.mobile.getRuntimePairingUrl({
      address: '127.0.0.1',
      rotate: true
    })
    if (!offer.available || !offer.pairingUrl) {
      throw new Error('HUB runtime did not provide a desktop pairing URL')
    }
    return {
      pairingUrl: offer.pairingUrl,
      ...(offer.webClientUrl ? { webClientUrl: offer.webClientUrl } : {})
    }
  })
}

export async function launchPairedWebClient(
  hubApp: ElectronApplication,
  offer: RuntimeDesktopPairingOffer
): Promise<PairedWebClient> {
  if (!offer.webClientUrl) {
    throw new Error('HUB runtime did not provide a paired web client URL')
  }
  const pagePromise = hubApp.waitForEvent('window')
  await hubApp.evaluate(
    async ({ BrowserWindow }, { partition, url }) => {
      const clientWindow = new BrowserWindow({
        height: 1200,
        show: false,
        width: 1440,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true
        }
      })
      await clientWindow.loadURL(url)
    },
    {
      partition: `e2e-nested-runtime-web-${randomUUID()}`,
      url: offer.webClientUrl
    }
  )
  const page = await pagePromise
  await page.locator('[data-worktree-sidebar]').waitFor({ state: 'visible', timeout: 30_000 })
  return { page, dispose: () => page.close() }
}

export async function launchPairedElectronClient(
  offer: RuntimeDesktopPairingOffer,
  testInfo: TestInfo,
  name: string
): Promise<PairedElectronClient> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-paired-desktop-'))
  const directSshProbePath = path.join(userDataDir, 'forbidden-local-ssh-connects.jsonl')
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir,
    codexRealHomeEnabled: false
  })
  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(mainPath, false),
    env: {
      ...homeIsolation.env,
      NODE_ENV: 'development',
      ORCA_E2E_HEADLESS: '1',
      ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE: directSshProbePath
    }
  })

  try {
    assertElectronResolvedIsolatedHome(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      homeIsolation
    )
    forwardElectronProcessLogs(app, testInfo)
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 30_000 }
    )
    const canaryBlocked = await page.evaluate(async (targetId) => {
      try {
        await window.api.ssh.connect({ targetId })
        return false
      } catch (error) {
        return String(error).includes('e2e_forbidden_local_ssh_connect')
      }
    }, DIRECT_SSH_PROBE_CANARY_TARGET_ID)
    if (
      !canaryBlocked ||
      !readDirectSshAttemptTargetIds(directSshProbePath).includes(DIRECT_SSH_PROBE_CANARY_TARGET_ID)
    ) {
      throw new Error('Paired-client direct SSH probe did not intercept its canary attempt')
    }

    const environmentId = await page.evaluate(
      async ({ name, pairingUrl }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Paired desktop store is unavailable')
        }
        const result = await window.api.runtimeEnvironments.addFromPairingCode({
          name,
          pairingCode: pairingUrl
        })
        const environments = await window.api.runtimeEnvironments.list()
        store.getState().setRuntimeEnvironments(environments)
        if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
          throw new Error('Paired desktop could not reach the HUB runtime')
        }
        if (!(await store.getState().switchRuntimeEnvironment(result.environment.id))) {
          throw new Error('Paired desktop could not select the HUB runtime')
        }
        return result.environment.id
      },
      { name, pairingUrl: offer.pairingUrl }
    )
    const captureDirectSshAttempts = async (): Promise<void> => {}
    const replacePairingInPlace = async (
      replacementOffer: RuntimeDesktopPairingOffer
    ): Promise<SameIdPairingReplacement> =>
      replaceRuntimePairingInPlace({
        environmentId,
        page,
        pairingUrl: replacementOffer.pairingUrl,
        userDataDir
      })

    return {
      app,
      page,
      environmentId,
      captureDirectSshAttempts,
      dispose: async () => {
        await closeElectronAppForE2E(app)
        await cleanupE2EDaemons(userDataDir)
        await removeProfile(userDataDir)
      },
      getDirectSshAttemptTargetIds: async () => {
        return readDirectSshAttemptTargetIds(directSshProbePath).filter(
          (targetId) => targetId !== DIRECT_SSH_PROBE_CANARY_TARGET_ID
        )
      },
      installDirectSshAttemptProbe: async () => {},
      replacePairingInPlace
    }
  } catch (error) {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    await removeProfile(userDataDir)
    throw error
  }
}

export async function rePairPairedElectronClient(
  client: PairedElectronClient,
  offer: RuntimeDesktopPairingOffer,
  name: string
): Promise<void> {
  await client.captureDirectSshAttempts()
  const environmentId = await client.page.evaluate(
    async ({ currentEnvironmentId, name, pairingUrl }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Paired desktop store is unavailable')
      }
      await window.api.runtimeEnvironments.remove({ selector: currentEnvironmentId })
      const result = await window.api.runtimeEnvironments.addFromPairingCode({
        name,
        pairingCode: pairingUrl
      })
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(result.environment.id))) {
        throw new Error('Re-paired desktop could not reach the HUB runtime')
      }
      if (!(await store.getState().switchRuntimeEnvironment(result.environment.id))) {
        throw new Error('Re-paired desktop could not select the HUB runtime')
      }
      return result.environment.id
    },
    {
      currentEnvironmentId: client.environmentId,
      name,
      pairingUrl: offer.pairingUrl
    }
  )
  client.environmentId = environmentId
  // Why: removing and re-adding the same HUB changes the environment identity; remount so no pane keeps the retired transport wrapper.
  await client.page.reload()
  await client.page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    { timeout: 30_000 }
  )
  await client.installDirectSshAttemptProbe()
  const reachable = await client.page.evaluate(async (nextEnvironmentId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Re-paired desktop store is unavailable after reload')
    }
    if (!(await store.getState().refreshRuntimeEnvironmentStatus(nextEnvironmentId))) {
      return false
    }
    return store.getState().switchRuntimeEnvironment(nextEnvironmentId)
  }, environmentId)
  if (!reachable) {
    throw new Error('Re-paired desktop could not reach the HUB after reload')
  }
}
