/**
 * WSL-via-orcad C7 with a fake WSL transport: no wsl.exe in CI. The HUB fixture stands in for the
 * distro's orcad; a second desktop, launched with ORCA_E2E_FAKE_WSL_HOSTS, adds that "distro" as a
 * host through the real add-host UI, adds a project on it, and runs a terminal there.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
import { RuntimeClient } from '../../src/cli/runtime/client'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { encodePairingOffer } from '../../src/shared/pairing'
import { listEnvironments } from '../../src/shared/runtime-environment-store'
import {
  addWslHostEnvironment,
  findWslHostDeployment
} from '../../src/shared/runtime-environment-wsl-host-store'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
const WSL_HOST_LABEL = 'Ubuntu (WSL)'
const UBUNTU_DISTRO = { name: 'Ubuntu', state: 'running', version: 2 }
const LEGACY_DISTRO = { name: 'Legacy', state: 'stopped', version: 1 }

async function launchDesktopWithFakeWsl(
  pairingCode: string,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1],
  fakeOverrides: Record<string, unknown> = {},
  options: { internalGate?: boolean; beforeLaunch?: (userDataDir: string) => void } = {}
): Promise<{
  app: ElectronApplication
  page: Page
  userDataDir: string
  dispose: () => Promise<void>
}> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-desktop-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  options.beforeLaunch?.(userDataDir)
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      // WSL hosts exist only behind this internal gate; the gated-off test leaves it closed.
      ...(options.internalGate === false ? {} : { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' }),
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify({
        distros: [
          { name: 'Ubuntu', state: 'running', version: 2 },
          { name: 'Legacy', state: 'stopped', version: 1 }
        ],
        pairingCode,
        ...fakeOverrides
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
    return { app, page, userDataDir, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** Every distro the fake connector was asked to start, from the log file it appends to. */
function fakeWslConnects(connectLogFile: string): string[] {
  return existsSync(connectLogFile)
    ? readFileSync(connectLogFile, 'utf8').split('\n').filter(Boolean)
    : []
}

async function setWslHostsEnabled(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (experimentalWslHosts) => {
    const settings = await window.api.settings.set({ experimentalWslHosts })
    window.__store?.setState({ settings })
  }, enabled)
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
      delete process.env.ORCA_E2E_PICKER_DEFAULT_PATH
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1)
        const defaultPath =
          typeof options === 'object' && options !== null && 'defaultPath' in options
            ? String(options.defaultPath)
            : 'none'
        process.env.ORCA_E2E_PICKER_DEFAULT_PATH = defaultPath
        return { canceled: false, filePaths: [filePath] }
      }
    }, picked)
    await openSidebarProjectDialog(page)
    const dialog = page.getByRole('dialog', { name: /Add a project/i })
    await dialog.getByRole('combobox').click()
    await page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL }).click()
    await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
  }
  const pickerDefaultPath = (): Promise<string | null> =>
    app.evaluate((): string | null => process.env.ORCA_E2E_PICKER_DEFAULT_PATH ?? null)

  // A pick through the lowercase share name lands as the host's Linux path.
  const uncPick = `\\\\wsl.localhost\\ubuntu${projectPath.replace(/\//g, '\\')}`
  await pickFolder(uncPick)
  const manual = page.getByRole('dialog', { name: /Open host project/i })
  await expect(manual.locator('#server-project-path')).toHaveValue(projectPath, { timeout: 30_000 })
  // It opened at the host's home, spelled through the distro's canonical name.
  expect(await pickerDefaultPath()).toMatch(/^\\\\wsl\.localhost\\Ubuntu\\/)
  await settleAnimations(page)
  await page.screenshot({ path: testInfo.outputPath('wsl-windows-folder-picker-filled.png') })
  await page.keyboard.press('Escape')
  await expect(manual).toBeHidden()

  // A drive folder is refused with copy that says it stays on this computer.
  await pickFolder('C:\\Users\\me\\src')
  await expect(page.getByText('Pick a folder inside Ubuntu.')).toBeVisible()
  await settleAnimations(page)
  await page.screenshot({ path: testInfo.outputPath('wsl-windows-folder-picker-drive.png') })
  await page.keyboard.press('Escape')
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
  // Starts with only a WSL 1 distro; Ubuntu is "imported" while the add dialog is open.
  const distrosDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-distros-'))
  const distrosFile = path.join(distrosDir, 'distros.json')
  writeFileSync(distrosFile, JSON.stringify([LEGACY_DISTRO]))
  const connectLogFile = path.join(distrosDir, 'connects.log')
  const desktop = await launchDesktopWithFakeWsl(offer.pairingUrl, testInfo, {
    distrosFile,
    connectLogFile
  })
  const projectPath = createGitProject()
  const cleanupDirs: string[] = []
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)

    await openSidebarProjectDialog(page)
    const addProject = page.getByRole('dialog', { name: /Add a project/i })
    await addProject.getByRole('combobox').click()
    await page.locator('[cmdk-item]').filter({ hasText: 'Add remote host' }).click()
    await page.getByRole('button', { name: /Add WSL distro/ }).click()

    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost).toBeVisible()
    await expect(addHost.getByRole('combobox')).toContainText('Choose a distro')
    writeFileSync(distrosFile, JSON.stringify([UBUNTU_DISTRO, LEGACY_DISTRO]))
    await addHost.getByRole('button', { name: 'Refresh' }).click()
    // Only Ubuntu can be added (Legacy is WSL 1), so it is preselected.
    await expect(addHost.getByRole('combobox')).toContainText('Ubuntu')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-add-host-dialog.png') })

    await addHost.getByRole('button', { name: 'Add host' }).click()
    await expect(addHost).toBeHidden({ timeout: 60_000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            (environmentId) =>
              window.__store
                ?.getState()
                .runtimeEnvironments.find((environment) => environment.id === environmentId)
                ?.orcadDeployment?.kind ?? null,
            WSL_ENVIRONMENT_ID
          ),
        { timeout: 30_000 }
      )
      .toBe('wsl')

    // The add-project dialog stays open under the add-host dialog, as it does for SSH hosts.
    const picker = addProject.getByRole('combobox')
    await picker.click()
    const hostRow = page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL })
    await expect(hostRow).toContainText('WSL distro', { timeout: 60_000 })
    await expect(hostRow).toContainText('Connected', { timeout: 60_000 })
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row.png') })
    await hostRow.click()
    await expect(picker).toContainText(WSL_HOST_LABEL)

    const dialog = page.getByRole('dialog', { name: /Add a project/i })
    await dialog.getByRole('button', { name: /Browse folder|Browse host/i }).click()
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

    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store?.getState().repos.find((repo) => repo.path === repoPath)
                ?.executionHostId ?? null,
            projectPath
          ),
        { timeout: 60_000 }
      )
      .toBe(`runtime:${encodeURIComponent(WSL_ENVIRONMENT_ID)}`)

    // Matched by repo: the worktree path may be reported under its realpath (/private/var on macOS).
    await expect
      .poll(
        () =>
          page.evaluate(
            ({ repoPath, environmentId }) => {
              const state = window.__store?.getState()
              const repo = state?.repos.find((entry) => entry.path === repoPath)
              const worktree = repo
                ? state?.allWorktrees().find((entry) => entry.repoId === repo.id)
                : undefined
              if (!state || !worktree) {
                return false
              }
              state.setActiveWorktree(worktree.id, `runtime:${encodeURIComponent(environmentId)}`)
              return true
            },
            { repoPath: projectPath, environmentId: WSL_ENVIRONMENT_ID }
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    const ptyId = await waitForActivePanePtyId(page, 30_000)
    expect(ptyId).toMatch(/^remote:/)
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
    const hubHasRepo = async (dir: string): Promise<boolean> => {
      const listed = await hubRuntime.call<{ repos: { path: string }[] }>('repo.list')
      return listed.result.repos.some((repo) => repo.path.endsWith(path.basename(dir)))
    }

    // Removing the project ends its shell on the host and drops it from the host's own catalog,
    // so re-adding the host cannot bring it back.
    expect(await hubTerminalsIn(projectPath)).toBeGreaterThan(0)
    await page.evaluate(
      async ({ repoPath, environmentId }) => {
        const state = window.__store?.getState()
        const repo = state?.repos.find((entry) => entry.path === repoPath)
        if (state && repo) {
          await state.removeProject(repo.id, {
            hostId: `runtime:${encodeURIComponent(environmentId)}`,
            errorFeedback: 'toast'
          })
        }
      },
      { repoPath: projectPath, environmentId: WSL_ENVIRONMENT_ID }
    )
    await expect.poll(() => hubTerminalsIn(projectPath), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => hubHasRepo(projectPath), { timeout: 30_000 }).toBe(false)

    // A shell only the host knows of: no desktop pane ever opened it. Why not a removed project's
    // orphan: repo.rm now ends the project's shells on the host itself (#29964).
    const hostOnlyPath = realpathSync(createGitProject())
    cleanupDirs.push(hostOnlyPath)
    await hubRuntime.call('repo.add', { path: hostOnlyPath })
    await hubRuntime.call('terminal.create', { worktree: `path:${hostOnlyPath}` })
    expect(await hubTerminalsIn(hostOnlyPath)).toBeGreaterThan(0)

    // Experiment off: the host stays listed so its projects never seem to vanish, but turned off.
    await setWslHostsEnabled(page, false)
    await openSidebarProjectDialog(page)
    await page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('combobox')
      .click()
    const offRow = page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL })
    await expect(offRow).toContainText('Turned off in Settings → Experimental')
    await expect(offRow.getByRole('button', { name: 'Turn on' })).toBeVisible()
    await expect(offRow.getByRole('button', { name: 'Connect' })).toHaveCount(0)
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-row-turned-off.png') })
    await page.keyboard.press('Escape')
    const addProjectAgain = page.getByRole('dialog', { name: /Add a project/i })
    await expect(offRow).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(addProjectAgain).toBeHidden()

    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'servers', repoId: null })
    })
    // A WSL host is listed only as a WSL host, never among the generic remote servers.
    await expect(page.getByText('No saved servers', { exact: true })).toBeVisible()
    const section = page.locator('[data-settings-section="wsl-hosts"]')
    await section.scrollIntoViewIfNeeded()
    await expect(section).toContainText('WSL hosts are turned off in Settings → Experimental')
    await expect(section.getByRole('button', { name: 'Connect' })).toBeDisabled()
    await settleAnimations(page)
    await section.screenshot({ path: testInfo.outputPath('wsl-hosts-settings-turned-off.png') })

    // Remove asks first, with WSL-specific copy, then drops the host.
    await setWslHostsEnabled(page, true)
    await section.getByRole('button', { name: `More actions for ${WSL_HOST_LABEL}` }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    const confirm = page.getByRole('dialog', { name: `Remove ${WSL_HOST_LABEL}?` })
    await expect(confirm).toContainText(
      'ends its open terminals and stops Orca’s server in that distro'
    )
    await expect(confirm).toContainText('Files in the distro are untouched.')
    await settleAnimations(page)
    await page.screenshot({ path: testInfo.outputPath('wsl-host-remove-confirm.png') })
    await confirm.getByRole('button', { name: 'Remove host' }).click()
    await expect(confirm).toBeHidden({ timeout: 30_000 })
    // Closed by handle, so the host-only shell ends too, and nothing is reported left running.
    await expect.poll(() => hubTerminalsIn(hostOnlyPath), { timeout: 30_000 }).toBe(0)
    await expect(page.getByText(/something in the distro is still running/)).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(
          (environmentId) =>
            window.__store
              ?.getState()
              .runtimeEnvironments.some((environment) => environment.id === environmentId) ?? true,
          WSL_ENVIRONMENT_ID
        )
      )
      .toBe(false)
    // The project that lived on the host is no longer active, and nothing starts for the host
    // again, though its rows still point at it (the respawn loop after removal).
    expect(
      await page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null)
    ).toBeNull()
    const connectsAfterRemoval = fakeWslConnects(connectLogFile)
    expect(connectsAfterRemoval).toContain('Ubuntu')
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    expect(fakeWslConnects(connectLogFile)).toEqual(connectsAfterRemoval)
  } finally {
    await desktop.dispose()
    rmSync(projectPath, { recursive: true, force: true })
    rmSync(distrosDir, { recursive: true, force: true })
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a build without the WSL host server files says so instead of failing an add', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const desktop = await launchDesktopWithFakeWsl(offer.pairingUrl, testInfo, {
    serverFiles: 'missing'
  })
  try {
    const { page } = desktop
    await setWslHostsEnabled(page, true)
    await openSidebarProjectDialog(page)
    await page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('combobox')
      .click()
    await page.locator('[cmdk-item]').filter({ hasText: 'Add remote host' }).click()
    await page.getByRole('button', { name: /Add WSL distro/ }).click()
    const addHost = page.getByRole('dialog', { name: 'Add WSL distro' })
    await expect(addHost.getByRole('alert')).toHaveText(
      'This build of Orca can’t run WSL hosts (server files missing).'
    )
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

test('with the internal gate closed, no WSL host surface shows and a saved host stays untouched', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-gate-'))
  const connectLogFile = path.join(logDir, 'connects.log')
  const desktop = await launchDesktopWithFakeWsl(
    offer.pairingUrl,
    testInfo,
    { connectLogFile },
    {
      internalGate: false,
      // A host saved during internal testing: it must be ignored, never deleted.
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
    const { page, userDataDir } = desktop
    // The user-level setting being on must not reveal anything behind the closed gate.
    await setWslHostsEnabled(page, true)
    expect(await page.evaluate(() => window.api.runtimeEnvironments.wslHosts)).toBeUndefined()
    const listed = await page.evaluate(() => window.api.runtimeEnvironments.list())
    expect(listed.map((environment) => environment.id)).not.toContain(WSL_ENVIRONMENT_ID)

    await openSidebarProjectDialog(page)
    await page
      .getByRole('dialog', { name: /Add a project/i })
      .getByRole('combobox')
      .click()
    await expect(page.locator('[cmdk-item]').filter({ hasText: WSL_HOST_LABEL })).toHaveCount(0)
    await page.locator('[cmdk-item]').filter({ hasText: 'Add remote host' }).click()
    await expect(page.getByRole('button', { name: /Add SSH host/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Add WSL distro/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsPage()
      state?.openSettingsTarget({ pane: 'experimental', repoId: null })
    })
    await expect(page.getByText('Cloud VM').first()).toBeVisible()
    await expect(page.getByText('WSL distros as hosts')).toHaveCount(0)
    await page.evaluate(() =>
      window.__store?.getState().openSettingsTarget({ pane: 'servers', repoId: null })
    )
    await expect(page.getByText('No saved servers', { exact: true })).toBeVisible()
    await expect(page.locator('[data-settings-section="wsl-hosts"]')).toHaveCount(0)
    await expect(page.getByText(WSL_HOST_LABEL)).toHaveCount(0)

    expect(fakeWslConnects(connectLogFile)).toEqual([])
    expect(listEnvironments(userDataDir).map((environment) => environment.id)).toContain(
      WSL_ENVIRONMENT_ID
    )
    expect(findWslHostDeployment(userDataDir, WSL_ENVIRONMENT_ID)).not.toBeNull()
    await page.screenshot({ path: testInfo.outputPath('wsl-hosts-gated-off-settings.png') })
  } finally {
    await desktop.dispose()
    rmSync(logDir, { recursive: true, force: true })
  }
})
