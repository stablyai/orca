/**
 * WSL-via-orcad C7 with a fake WSL transport: no wsl.exe in CI. The HUB fixture stands in for the
 * distro's orcad; a second desktop, launched with ORCA_E2E_FAKE_WSL_HOSTS, adds that "distro" as a
 * host through the real add-host UI, adds a project on it, and runs a terminal there.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test, type forwardElectronProcessLogs } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { encodePairingOffer } from '../../src/shared/remote-runtime/pairing/pairing'
import { addWslHostEnvironment } from '../../src/shared/remote-runtime/host-store/runtime-environment-wsl-host-operations'
import { openSidebarProjectMenu } from './helpers/sidebar-project-dialog'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  launchDesktopWithFakeWslPairing,
  setWslHostsEnabled
} from './helpers/wsl-host-fake-desktop'

const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
const WSL_HOST_LABEL = 'Ubuntu (WSL)'
const UBUNTU_DISTRO = { name: 'Ubuntu', state: 'running', version: 2 }
const LEGACY_DISTRO = { name: 'Legacy', state: 'stopped', version: 1 }

async function openAddRemoteHostMenu(page: Page): Promise<void> {
  await openSidebarProjectMenu(page)
  await page.getByRole('menuitem', { name: /Project host:/i }).hover()
  await page.getByRole('menuitem', { name: /Add remote host/i }).hover()
}

async function settleAnimations(page: Page): Promise<void> {
  // Why finite only: spinners and pulses run forever; the dialog and popover fades do not.
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

function createGitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-project-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), '# wsl host project\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

/**
 * C8: Add Project's Browse opens Windows' folder picker over the WSL host's distro. The renderer is
 * told it runs on Windows; main's native dialog is stubbed, since there is no Explorer here.
 */
async function checkWindowsFolderPicker(
  desktop: { app: ElectronApplication; page: Page },
  projectPath: string,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1]
): Promise<void> {
  const { app, page } = desktop
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Electron'
  })
  const pickFolder = async (picked: string): Promise<void> => {
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => {
        return { canceled: false, filePaths: [filePath] }
      }
    }, picked)
    await openSidebarProjectMenu(page)
    await page.getByRole('menuitem', { name: /Project host:/i }).hover()
    await page.getByRole('menuitem', { name: /^Ubuntu \(WSL\)/ }).click()
    await page.getByRole('menuitem', { name: /Browse folder/i }).click()
  }
  // A pick through the lowercase share name lands as the host's Linux path.
  const uncPick = `\\\\wsl.localhost\\ubuntu${projectPath.replace(/\//g, '\\')}`
  await pickFolder(uncPick)
  const manual = page.getByRole('dialog', { name: /Open host project/i })
  await expect(manual.locator('#server-project-path')).toHaveValue(projectPath, { timeout: 30_000 })
  await settleAnimations(page)
  await page.screenshot({ path: testInfo.outputPath('wsl-windows-folder-picker-filled.png') })
  await manual.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(manual).toBeHidden()

  await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' })
  await cdp.detach()
}

test('adds a WSL distro as a host, adds a project on it, and runs a terminal there', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  // Starts with only a WSL 1 distro; Ubuntu is "imported" while the add-host dialog is open.
  const distrosDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-distros-'))
  const distrosFile = path.join(distrosDir, 'distros.json')
  writeFileSync(distrosFile, JSON.stringify([LEGACY_DISTRO]))
  const desktop = await launchDesktopWithFakeWslPairing(offer.pairingUrl, testInfo, {
    distrosFile
  })
  const projectPath = createGitProject()
  const cleanupDirs: string[] = []
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)

    await openAddRemoteHostMenu(page)
    await page.getByRole('menuitem', { name: /^Add WSL distro/ }).click()

    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost).toBeVisible()
    writeFileSync(distrosFile, JSON.stringify([UBUNTU_DISTRO, LEGACY_DISTRO]))
    await addHost.getByRole('button', { name: 'Refresh' }).click()
    // Only Ubuntu can be added (Legacy is WSL 1), so it is preselected.
    await expect(addHost.getByRole('combobox')).toContainText('Ubuntu')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-add-host-dialog.png') })

    await addHost.getByRole('button', { name: 'Add host' }).click()
    await expect(addHost).toBeHidden({ timeout: 60_000 })
    await openSidebarProjectMenu(page)
    const projectMenu = page.getByRole('menu', { name: 'Add project' })
    const picker = projectMenu.getByRole('menuitem', { name: /Project host:/i })
    await picker.hover()
    const hostRow = page.getByRole('menuitem', { name: /^Ubuntu \(WSL\)/ })
    await expect(hostRow).toBeEnabled({ timeout: 60_000 })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row.png') })
    await hostRow.click()
    await expect(picker).toContainText(WSL_HOST_LABEL)

    await projectMenu.getByRole('menuitem', { name: /Browse folder/i }).click()
    const browse = page.getByRole('dialog', { name: /Browse host filesystem/i })
    await expect(browse).toBeVisible()
    // Off Windows, Browse keeps the in-app browser; C8's Windows picker is checked further down.
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-browse-in-app.png') })
    await browse.getByRole('button', { name: /^Cancel$/i }).click()
    const manual = page.getByRole('dialog', { name: /Open host project/i })
    await manual.locator('#server-project-path').fill(projectPath)
    await manual.getByRole('button', { name: /Add Git Project/i }).click()
    await expect(manual).toBeHidden({ timeout: 60_000 })

    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    // Why: keys typed before the shell's first prompt can be dropped; its prompt names the project folder.
    await waitForTerminalOutput(page, path.basename(projectPath), 30_000)
    await focusActiveTerminalInput(page)
    await page.keyboard.type("printf 'WSL_HOST_TERMINAL_%s\\n' ready")
    await page.keyboard.press('Enter')
    await waitForTerminalOutput(page, 'WSL_HOST_TERMINAL_ready', 30_000)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-terminal.png') })

    await checkWindowsFolderPicker(desktop, projectPath, testInfo)

    // The "distro's orcad" is the HUB, so what it still runs is what a real distro would.
    const hubRuntime = new RuntimeClient(
      await electronApp.evaluate(({ app }) => app.getPath('userData'))
    )
    // Live shells only: the hub may keep a pty-less tab record for a moment after its shell ends.
    const hubTerminalsIn = async (dir: string): Promise<number> => {
      const listed = await hubRuntime.call<{
        terminals: { worktreeId: string; ptyId: string | null }[]
      }>('terminal.list')
      return listed.result.terminals.filter(
        (terminal) => terminal.ptyId !== null && terminal.worktreeId.includes(path.basename(dir))
      ).length
    }
    expect(await hubTerminalsIn(projectPath)).toBeGreaterThan(0)

    // A shell only the host knows of: no desktop pane ever opened it.
    const hostOnlyPath = realpathSync(createGitProject())
    cleanupDirs.push(hostOnlyPath)
    await hubRuntime.call('repo.add', { path: hostOnlyPath })
    await hubRuntime.call('terminal.create', { worktree: `path:${hostOnlyPath}` })
    expect(await hubTerminalsIn(hostOnlyPath)).toBeGreaterThan(0)

    // Setting off (Stage 1): it governs new work only, so the host keeps serving its projects,
    // as in serve-only. Only adding a host and moving projects stop.
    await setWslHostsEnabled(page, false)
    // Through the desktop's own host connection, not the hub directly: the host still serves.
    const callHostFromDesktop = (method: string, params: unknown): Promise<boolean> =>
      page.evaluate(async (args) => (await window.api.runtimeEnvironments.call(args)).ok, {
        selector: WSL_ENVIRONMENT_ID,
        method,
        params,
        timeoutMs: 30_000
      })
    expect(await callHostFromDesktop('terminal.create', { worktree: `path:${hostOnlyPath}` })).toBe(
      true
    )
    await expect.poll(() => hubTerminalsIn(hostOnlyPath), { timeout: 30_000 }).toBeGreaterThan(1)
    expect(await callHostFromDesktop('terminal.list', {})).toBe(true)
    expect(
      await page.evaluate(() => window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' }))
    ).toMatchObject({ ok: false, kind: 'disabled' })
    expect(
      await page.evaluate(() => window.api.wslMove.start({ distro: 'Ubuntu', repoIds: [] }))
    ).toMatchObject({ outcome: 'refused', code: 'wsl_move_unavailable' })
    await openSidebarProjectMenu(page)
    await page.getByRole('menuitem', { name: /Project host:/i }).hover()
    const offRow = page.getByRole('menuitem', { name: /^Ubuntu \(WSL\)/ })
    await expect(offRow).toBeVisible()
    await expect(offRow).toBeEnabled()
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row-setting-off.png') })
    await page.keyboard.press('Escape')
    const addProjectAgain = page.getByRole('menu', { name: 'Add project' })
    await expect(offRow).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(addProjectAgain).toBeHidden()

    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    const section = page.locator('[data-settings-section="wsl-hosts"]')
    await section.scrollIntoViewIfNeeded()
    await expect(section).toContainText(WSL_HOST_LABEL)
    // No new host while the setting is off.
    await expect(section.getByRole('button', { name: 'Add WSL distro' })).toHaveCount(0)
    await settleAnimations(page)
    await section.screenshot({ path: testInfo.outputPath('wsl-hosts-settings-setting-off.png') })

    // Removing the host asks first, then ends its shells and drops its catalog entry.
    await setWslHostsEnabled(page, true)
    await section.getByRole('button', { name: `More actions for ${WSL_HOST_LABEL}` }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    const confirm = page.getByRole('dialog', { name: `Remove ${WSL_HOST_LABEL}?` })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-remove-confirm.png') })
    await confirm.getByRole('button', { name: 'Remove host' }).click()
    await expect(confirm).toBeHidden({ timeout: 30_000 })
    // Closed by handle, so the host-only shell ends too, and nothing is reported left running.
    await expect.poll(() => hubTerminalsIn(hostOnlyPath), { timeout: 30_000 }).toBe(0)
    await expect
      .poll(() =>
        page.evaluate(
          (environmentId) =>
            window.api.runtimeEnvironments
              .list()
              .then((environments) =>
                environments.some((environment) => environment.id === environmentId)
              ),
          WSL_ENVIRONMENT_ID
        )
      )
      .toBe(false)
  } finally {
    await desktop.dispose()
    rmSync(projectPath, { recursive: true, force: true })
    rmSync(distrosDir, { recursive: true, force: true })
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('refuses adding a WSL host without server files', async ({ orcaPage }, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const desktop = await launchDesktopWithFakeWslPairing(offer.pairingUrl, testInfo, {
    serverFiles: 'missing'
  })
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)
    await openAddRemoteHostMenu(page)
    await page.getByRole('menuitem', { name: /^Add WSL distro/ }).click()
    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost.getByRole('button', { name: 'Add host' })).toBeDisabled()
    await expect(addHost.getByRole('combobox')).toBeDisabled()
    // Main refuses too, before any deploy work.
    expect(
      await page.evaluate(() => window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' }))
    ).toMatchObject({ ok: false, kind: 'server-files-missing' })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-add-host-server-files-missing.png') })
  } finally {
    await desktop.dispose()
  }
})

test('with the internal gate closed, a saved WSL host stays reachable but nothing new is added or moved (serve-only)', async ({
  orcaPage
}, testInfo) => {
  // Launches a second desktop beside the paired server, like the gate-closed case above.
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const desktop = await launchDesktopWithFakeWslPairing(
    offer.pairingUrl,
    testInfo,
    {},
    {
      internalGate: false,
      // A host saved while the gate was open: closing the gate must not strand it.
      beforeLaunch: (userDataDir) =>
        addWslHostEnvironment(userDataDir, {
          id: WSL_ENVIRONMENT_ID,
          name: WSL_HOST_LABEL,
          pairingCode: encodePairingOffer({
            v: 2,
            endpoint: 'ws://127.0.0.1:42000',
            deviceToken: 'gated-token',
            publicKeyB64: Buffer.alloc(32, 7).toString('base64')
          }),
          record: {
            kind: 'wsl',
            distro: 'Ubuntu',
            distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
            localPort: 42000,
            remotePort: 6768
          }
        })
    }
  )
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)
    const listed = await page.evaluate(() => window.api.runtimeEnvironments.list())
    expect(listed.map((environment) => environment.id)).toContain(WSL_ENVIRONMENT_ID)

    await page.evaluate(
      (environmentId) => window.api.runtimeEnvironments.wslHosts?.connect({ environmentId }),
      WSL_ENVIRONMENT_ID
    )
    expect(
      await page.evaluate(
        (environmentId) =>
          window.api.runtimeEnvironments.call({
            selector: environmentId,
            method: 'terminal.list',
            params: {},
            timeoutMs: 30_000
          }),
        WSL_ENVIRONMENT_ID
      )
    ).toMatchObject({ ok: true })

    // Serve-only admits nothing new: main refuses, and the entry points are gone.
    expect(
      await page.evaluate(() => window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' }))
    ).toMatchObject({ ok: false, kind: 'disabled' })
    expect(
      await page.evaluate(() => window.api.wslMove.start({ distro: 'Ubuntu', repoIds: [] }))
    ).toMatchObject({ outcome: 'refused', code: 'wsl_move_unavailable' })
    await openAddRemoteHostMenu(page)
    await expect(page.getByRole('menuitem', { name: /^Add SSH host/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /^Add WSL distro/ })).toHaveCount(0)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-hosts-paused-add-host-menu.png') })
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: 'Add project' })).toBeHidden()

    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    await expect(page.getByText(WSL_HOST_LABEL).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Add WSL distro' })).toHaveCount(0)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-hosts-serve-only-settings.png') })
  } finally {
    await desktop.dispose()
  }
})
