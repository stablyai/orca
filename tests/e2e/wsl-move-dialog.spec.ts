/**
 * The WSL move dialog against a fake move transport: no wsl.exe or distro in CI. Main's
 * `wslMove:*` handlers are swapped for a scripted host, so the real dialog runs open preview →
 * blockers → skip → start → progress → refusal → start again → moved → reload. A second test
 * proves that with the internal gate closed none of it shows and main refuses.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { encodePairingOffer } from '../../src/shared/pairing'
import { addWslHostEnvironment } from '../../src/shared/runtime-environment-wsl-host-store'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import type {
  WslMovePreview,
  WslMoveProgressEvent,
  WslMoveResult
} from '../../src/shared/wsl-move/wsl-move-driver-types'

test.use({ seedTestRepo: false })

const DISTRO = 'Ubuntu'
const LEAF = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f'
// Visual proof for the PR; outside the repo on purpose.
const PROOF_DIR = process.env.ORCA_D1B9_PROOF_DIR

type Desktop = { app: ElectronApplication; page: Page; dispose: () => Promise<void> }

function createGitProject(name: string): string {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-move-')), name)
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

async function launch(
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  internalGate: boolean
): Promise<Desktop> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-move-ui-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  // A saved host for the distro; it never connects here, which the dialog does not need.
  addWslHostEnvironment(userDataDir, {
    id: 'wsl:ubuntu',
    name: `${DISTRO} (WSL)`,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:9',
      deviceToken: 'move-ui-token',
      publicKeyB64: Buffer.alloc(32, 7).toString('base64')
    }),
    record: {
      kind: 'wsl',
      distro: DISTRO,
      distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
      localPort: 9,
      remotePort: 6768
    }
  })
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      ...(internalGate ? { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' } : {}),
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify({
        distros: [{ name: DISTRO, state: 'stopped', version: 2 }],
        pairingCode: 'unused'
      })
    },
    userDataDir
  })
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADLESS: '1' }
  })
  forwardElectronProcessLogs(app, testInfo)
  const dispose = async (): Promise<void> => {
    await closeElectronAppForE2E(app)
    await cleanupE2EDaemons(userDataDir)
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
  try {
    const page = await app.firstWindow({ timeout: 120_000 })
    await page.waitForLoadState('domcontentloaded')
    await waitForSessionReady(page)
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ experimentalWslHosts: true })
      window.__store?.setState({ settings })
    })
    return { app, page, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function addProject(page: Page, projectPath: string): Promise<string> {
  const repoId = await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, projectPath)
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const store = window.__store
        await store?.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
        return Boolean(store?.getState().repos.some((repo) => repo.id === id))
      }, repoId)
    )
    .toBe(true)
  return repoId
}

/** The terminal tab of a project's main workspace, for a blocker that names one of its panes. */
async function terminalTabOf(page: Page, repoId: string): Promise<string> {
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const state = window.__store?.getState()
        await state?.fetchWorktrees(id)
        const worktree = window.__store?.getState().worktreesByRepo[id]?.[0]
        if (worktree) {
          window.__store?.getState().setActiveWorktree(worktree.id)
        }
        return Boolean(worktree)
      }, repoId)
    )
    .toBe(true)
  await ensureTerminalVisible(page, 30_000)
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const tab = state.tabsByWorktree[state.activeWorktreeId!]?.[0]
    if (!tab) {
      throw new Error('Expected a terminal tab')
    }
    return tab.id
  })
}

type FakeScript = {
  distroPreview: WslMovePreview
  selectionPreview: WslMovePreview
  results: WslMoveResult[]
}

/** The scripted host's state in Electron main, shared by the evaluate calls below. */
type FakeMoveState = {
  starts: unknown[]
  pending: ((result: unknown) => void)[]
  results: unknown[]
  unfinished: unknown[]
  cancelAllowed: boolean
}

declare global {
  // Set only in Electron main, by installFakeMove.
  var __wslMoveFake: FakeMoveState | undefined
}

/** Swaps main's move handlers for a scripted host; the renderer and its bridge stay real. */
async function installFakeMove(app: ElectronApplication, script: FakeScript): Promise<void> {
  await app.evaluate(({ ipcMain }, fake) => {
    const state: FakeMoveState = {
      starts: [],
      pending: [],
      results: [...fake.results],
      unfinished: [],
      cancelAllowed: true
    }
    globalThis.__wslMoveFake = state
    for (const channel of [
      'wslMove:preview',
      'wslMove:start',
      'wslMove:cancel',
      'wslMove:listUnfinished'
    ]) {
      ipcMain.removeHandler(channel)
    }
    ipcMain.handle('wslMove:preview', (_event, request: { repoIds?: string[] }) =>
      request.repoIds ? fake.selectionPreview : fake.distroPreview
    )
    ipcMain.handle('wslMove:start', (_event, request: unknown) => {
      state.starts.push(request)
      return new Promise((resolve) => state.pending.push(resolve))
    })
    ipcMain.handle('wslMove:cancel', () => state.cancelAllowed)
    ipcMain.handle('wslMove:listUnfinished', () => state.unfinished)
  }, script)
}

async function sendProgress(app: ElectronApplication, event: WslMoveProgressEvent): Promise<void> {
  await app.evaluate(({ BrowserWindow }, progress) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('wslMove:progress', progress)
    }
  }, event)
}

/** Ends the running start with the next scripted result. */
async function finishStart(app: ElectronApplication, unfinished: unknown[] = []): Promise<void> {
  await app.evaluate((_electron, nextUnfinished) => {
    const state = globalThis.__wslMoveFake
    if (!state) {
      throw new Error('installFakeMove did not run')
    }
    state.unfinished = nextUnfinished
    state.pending.shift()?.(state.results.shift())
  }, unfinished)
}

async function settle(page: Page): Promise<void> {
  // Finite animations only: spinners run forever; dialog fades do not.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity
      )
  )
}

async function proof(
  page: Page,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  name: string
): Promise<void> {
  await settle(page)
  const file = `wsl-move-${name}.png`
  await page.screenshot({ path: testInfo.outputPath(file) })
  if (PROOF_DIR) {
    await page.screenshot({ path: path.join(PROOF_DIR, file) })
  }
}

async function openServersPane(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsPage()
    state?.openSettingsTarget({ pane: 'servers', repoId: null })
  })
  await expect(page.locator('[data-settings-section="wsl-hosts"]')).toBeVisible({ timeout: 30_000 })
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('moves projects through preview, blockers, progress and result', async ({}, testInfo) => {
  // Two git projects are created, previewed and moved through every dialog step.
  test.setTimeout(240_000)
  const apiPath = createGitProject('payments-api')
  const webPath = createGitProject('web-app')
  const desktop = await launch(testInfo, true)
  const { app, page } = desktop
  try {
    const apiId = await addProject(page, apiPath)
    const webId = await addProject(page, webPath)
    const webTab = await terminalTabOf(page, webId)
    const ready = {
      outcome: 'ready' as const,
      distro: DISTRO,
      changed: [],
      heldByHost: [],
      refused: [{ kind: 'repo' as const, id: 'drive-repo', reason: 'windows-drive' }]
    }
    await installFakeMove(app, {
      distroPreview: {
        ...ready,
        repoIds: [apiId, webId],
        folderWorkspaceIds: [],
        blockers: [
          { kind: 'process-running', ids: [`${webTab}:${LEAF}`], actions: ['end', 'skip-project'] }
        ]
      },
      selectionPreview: { ...ready, repoIds: [apiId], folderWorkspaceIds: [], blockers: [] },
      results: [
        { outcome: 'refused', code: 'wsl_move_pause_failed', detail: 'sleep' },
        {
          outcome: 'moved',
          migrationId: 'move-1',
          phase: 'retained',
          reloadRequired: true,
          automationsPending: ['nightly-triage']
        }
      ]
    })

    // Entry: the WSL host row's menu in Settings → Servers.
    await openServersPane(page)
    const hosts = page.locator('[data-settings-section="wsl-hosts"]')
    await hosts.getByRole('button', { name: `More actions for ${DISTRO} (WSL)` }).click()
    const entry = page.getByRole('menuitem', { name: 'Move projects from this distro…' })
    await expect(entry).toBeVisible()
    await proof(page, testInfo, 'host-row-menu')
    await entry.click()
    const dialog = page.getByTestId('wsl-move-dialog')
    await expect(
      dialog.getByRole('heading', { name: `Move projects to the ${DISTRO} host` })
    ).toBeVisible()
    await expect(dialog.getByTestId('wsl-move-chats-stay')).toHaveText(
      'Existing chats stay on this computer. New chats in this project start on the WSL host.'
    )
    await expect(dialog.getByRole('checkbox')).toHaveCount(2)
    await expect(
      dialog.getByText('Its folder is on a Windows drive, so it stays on this computer.')
    ).toBeVisible()
    const blockers = dialog.getByTestId('wsl-move-blockers')
    await expect(blockers.getByText('A terminal is running a program')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Move 2 projects' })).toBeDisabled()
    await proof(page, testInfo, 'blockers')

    // Skip the blocked project: the selection narrows and its preview is clear.
    await blockers.getByRole('button', { name: 'Leave web-app out of this move' }).click()
    await expect(blockers).toHaveCount(0)
    const move = dialog.getByRole('button', { name: 'Move 1 project' })
    await expect(move).toBeEnabled()
    await expect(dialog.getByTestId('wsl-move-counts')).toContainText('Projects: 1')
    await proof(page, testInfo, 'preview')

    // First run: refused, with a plain message and a way back.
    await move.click()
    await expect(dialog.getByTestId('wsl-move-progress')).toBeVisible()
    await finishStart(app)
    await expect(dialog.getByTestId('wsl-move-result')).toHaveAttribute('data-outcome', 'refused')
    await expect(dialog.getByText('could not pause the terminals')).toBeVisible()
    await proof(page, testInfo, 'refusal')
    await dialog.getByRole('button', { name: 'Back to projects' }).click()
    await expect(dialog.getByRole('button', { name: 'Move 1 project' })).toBeEnabled()

    // Second run: progress steps and bytes, cancel only before the switch.
    await dialog.getByRole('button', { name: 'Move 1 project' }).click()
    await sendProgress(app, { distro: DISTRO, step: 'pausing-terminals', migrationId: 'move-1' })
    await sendProgress(app, {
      distro: DISTRO,
      step: 'copying',
      migrationId: 'move-1',
      bytesSent: 14 * 1024 * 1024,
      bytesTotal: 34 * 1024 * 1024
    })
    const progress = dialog.getByTestId('wsl-move-progress')
    await expect(progress.locator('[data-state="active"]')).toHaveText('Copying')
    await expect(dialog.getByText('14 MB of 34 MB')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel move' })).toBeEnabled()
    await proof(page, testInfo, 'progress')
    // Closing only hides a running move; the entry point shows it again.
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await hosts.getByRole('button', { name: `More actions for ${DISTRO} (WSL)` }).click()
    await page.getByRole('menuitem', { name: 'Move projects from this distro…' }).click()
    await expect(dialog.getByTestId('wsl-move-progress')).toBeVisible()
    await sendProgress(app, { distro: DISTRO, step: 'switching', migrationId: 'move-1' })
    await expect(dialog.getByRole('button', { name: 'Cancel move' })).toBeDisabled()

    await finishStart(app, [
      { migrationId: 'move-1', distro: DISTRO, automationsPending: ['nightly-triage'] }
    ])
    await expect(dialog.getByTestId('wsl-move-result')).toHaveAttribute('data-outcome', 'moved')
    await expect(dialog.getByTestId('wsl-move-automations-pending')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await proof(page, testInfo, 'success')
    expect(await app.evaluate(() => globalThis.__wslMoveFake?.starts)).toEqual([
      { distro: DISTRO, repoIds: [apiId], folderWorkspaceIds: [], sleptPanes: [] },
      { distro: DISTRO, repoIds: [apiId], folderWorkspaceIds: [], sleptPanes: [] }
    ])

    // Reload goes through restart preparation and lands a fresh page.
    const navigated = page.waitForEvent('framenavigated', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Reload now' }).click()
    await navigated
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
    await waitForSessionReady(page)
    await expect(page.getByTestId('wsl-move-dialog')).toHaveCount(0)

    // The automations still off show under the host until it confirms.
    await openServersPane(page)
    await expect(page.getByTestId('wsl-move-unfinished')).toContainText(
      `One automation moved to the ${DISTRO} host is still off.`
    )
    await proof(page, testInfo, 'unfinished-notice')
  } finally {
    await desktop.dispose()
    rmSync(path.dirname(apiPath), { recursive: true, force: true })
    rmSync(path.dirname(webPath), { recursive: true, force: true })
  }
})

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('with the internal gate closed, no move entry shows and main refuses', async ({}, testInfo) => {
  // The gated-off launch still boots a full app before main is asked to refuse.
  test.setTimeout(180_000)
  const desktop = await launch(testInfo, false)
  const { page } = desktop
  try {
    expect(
      await page.evaluate((distro) => window.api.wslMove.preview({ distro }), DISTRO)
    ).toMatchObject({ outcome: 'refused', code: 'wsl_move_unavailable' })
    expect(await page.evaluate(() => window.api.wslMove.listUnfinished())).toEqual([])
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    await expect(page.getByText('No saved servers', { exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(page.locator('[data-settings-section="wsl-hosts"]')).toHaveCount(0)
    await expect(page.getByText('Move projects from this distro…')).toHaveCount(0)
    await expect(page.getByTestId('wsl-move-dialog')).toHaveCount(0)
  } finally {
    await desktop.dispose()
  }
})
