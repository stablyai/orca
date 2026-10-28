/**
 * Native chat on a WSL host with a fake WSL transport: the HUB stands in for the distro's orcad and
 * runs the Claude stub. A second desktop adds the "distro" as a host, opens a chat on a project
 * there, then sees the distro stop: chat calls refuse without booting it (E9) and switching back
 * to the workspace boots it so the chat continues.
 */
// Minimum launch copied from wsl-host-fake-transport.spec.ts; move to a shared helper once one is on main.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
import { expect, forwardElectronProcessLogs } from './helpers/orca-app'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'
import { callEnvironment } from './helpers/paired-host-terminal'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { SUPPORTED, test } from './helpers/structured-claude-stub'
import { waitForSessionReady } from './helpers/store'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'

const WSL_ENVIRONMENT_ID = 'wsl:ubuntu'
const RUNNING = [{ name: 'Ubuntu', state: 'running', version: 2 }]
const STOPPED = [{ name: 'Ubuntu', state: 'stopped', version: 2 }]

async function launchDesktopWithFakeWsl(
  fake: Record<string, unknown>,
  testInfo: Parameters<typeof forwardElectronProcessLogs>[1]
): Promise<{ app: ElectronApplication; page: Page; dispose: () => Promise<void> }> {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-desktop-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      [WSL_HOSTS_INTERNAL_GATE_ENV]: '1',
      ORCA_E2E_FAKE_WSL_HOSTS: JSON.stringify(fake)
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
    return { app, page, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

function createGitProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-project-'))
  execFileSync('git', ['init', '-q', '-b', 'main', dir])
  writeFileSync(path.join(dir, 'README.md'), '# wsl host chat project\n')
  execFileSync('git', ['-C', dir, 'add', '.'])
  execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-qm', 'init'],
    { stdio: 'ignore' }
  )
  return dir
}

/** The fake re-reads this file on every check, so it must never see a half-written one. */
function writeDistros(distrosFile: string, distros: readonly object[]): void {
  const tmp = `${distrosFile}.tmp`
  writeFileSync(tmp, JSON.stringify(distros))
  renameSync(tmp, distrosFile)
}

function readDistroState(distrosFile: string): string | undefined {
  const distros: { state?: string }[] = JSON.parse(readFileSync(distrosFile, 'utf8'))
  return distros[0]?.state
}

function fakeWslConnects(connectLogFile: string): string[] {
  return existsSync(connectLogFile)
    ? readFileSync(connectLogFile, 'utf8').split('\n').filter(Boolean)
    : []
}

/** Focuses the project's worktree on the desktop, which is the act that may boot its distro. */
async function focusProject(page: Page, repoPath: string): Promise<string | null> {
  return page.evaluate(
    ({ repoPath, hostId }) => {
      const state = window.__store?.getState()
      const repo = state?.repos.find((entry) => entry.path === repoPath)
      const worktree = repo
        ? state?.allWorktrees().find((entry) => entry.repoId === repo.id)
        : undefined
      if (!state || !worktree) {
        return null
      }
      state.setActiveWorktree(worktree.id, hostId)
      return worktree.id
    },
    { repoPath, hostId: toRuntimeExecutionHostId(WSL_ENVIRONMENT_ID) }
  )
}

test.describe('native chat on a WSL host', () => {
  test.skip(!SUPPORTED, 'the Claude stub wrapper is POSIX-only')

  test('admits, streams, refuses while the distro is stopped, and continues after focus boots it', async ({
    orcaPage: hub,
    claudeStub
  }, testInfo) => {
    // Two Electron apps, a host add and two chat turns.
    test.setTimeout(300_000)
    await waitForSessionReady(hub)
    // The HUB is the distro's orcad: its settings are the host's, so the chat runs its stub.
    await hub.evaluate(async (command) => {
      await window.__store?.getState().updateSettings({
        experimentalNativeChat: true,
        agentCmdOverrides: { claude: command }
      })
    }, buildFakeAgentCommandOverride(claudeStub.command))
    const offer = await createRuntimeDesktopPairingOffer(hub)
    const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-wsl-chat-fake-'))
    const distrosFile = path.join(fakeDir, 'distros.json')
    const connectLogFile = path.join(fakeDir, 'connects.log')
    writeDistros(distrosFile, RUNNING)
    const desktop = await launchDesktopWithFakeWsl(
      { distros: RUNNING, distrosFile, connectLogFile, pairingCode: offer.pairingUrl },
      testInfo
    )
    const projectPath = createGitProject()
    try {
      const { page } = desktop
      await page.evaluate(async () => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
        await window.__store?.getState().updateSettings({
          experimentalNativeChat: true,
          defaultTuiAgent: 'claude'
        })
      })
      const added = await page.evaluate(() =>
        window.api.runtimeEnvironments.wslHosts?.add({ distro: 'Ubuntu' })
      )
      expect(added, JSON.stringify(added)).toMatchObject({ ok: true })
      await callEnvironment(page, WSL_ENVIRONMENT_ID, 'repo.add', {
        path: projectPath,
        kind: 'git'
      })
      await expect.poll(() => focusProject(page, projectPath), { timeout: 60_000 }).toBeTruthy()

      // Admission: the host, not this desktop, answers whether it can run the chat.
      const askSupport = () =>
        callEnvironment(page, WSL_ENVIRONMENT_ID, 'agentSession.createSupport', {
          worktree: `path:${projectPath}`,
          agent: 'claude'
        })
      expect(await askSupport()).toMatchObject({ supported: true })

      await page.getByRole('button', { name: 'New tab', exact: true }).first().click()
      await page
        .getByRole('menu')
        .getByText('Claude', { exact: true })
        .first()
        .click({ timeout: 60_000 })
      const chat = page.locator('[data-native-chat-root="true"]')
      await expect(chat).toBeVisible({ timeout: 60_000 })
      const composer = chat.getByRole('textbox')
      const send = async (text: string): Promise<void> => {
        // Typing before the composer is editable loses keys, notably right after a reconnect.
        await expect(composer).toBeEditable({ timeout: 60_000 })
        await composer.click()
        await page.keyboard.type(text)
        await expect(composer).toContainText(text)
        await chat.getByRole('button', { name: 'Send', exact: true }).click()
      }
      // The transcript only, so the composer still holding the prompt can't stand in for the message.
      const transcript = chat.locator('[data-native-chat-scroll]')
      /** The prompt's message, followed later in the transcript by a stub reply. */
      const expectReplyAfter = async (text: string): Promise<void> => {
        const prompt = transcript.getByText(text, { exact: true }).last()
        await expect(prompt).toBeVisible({ timeout: 60_000 })
        await expect(
          prompt.locator('xpath=following::*[text()="Stub reply."]').first()
        ).toBeVisible({ timeout: 120_000 })
      }
      await send('hello from the desktop')
      await expectReplyAfter('hello from the desktop')
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-streamed.png') })

      // The distro stops: a chat call is a runtime call, so it refuses rather than boot it.
      const connectsBeforeStop = fakeWslConnects(connectLogFile).length
      writeDistros(distrosFile, STOPPED)
      await expect
        .poll(
          () =>
            askSupport().then(
              () => 'answered',
              (error: unknown) => String(error)
            ),
          { timeout: 30_000 }
        )
        .toContain('Ubuntu was stopped')
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-stopped.png') })

      // Switching away and back is the user acting on the host: that boots it and the chat goes on.
      await page.evaluate(() => window.__store?.getState().setActiveWorktree(null))
      // The whole stopped window, up to the focus, booted nothing.
      expect(fakeWslConnects(connectLogFile)).toHaveLength(connectsBeforeStop)
      expect(readDistroState(distrosFile)).toBe('stopped')
      await expect.poll(() => focusProject(page, projectPath), { timeout: 30_000 }).toBeTruthy()
      await expect
        .poll(() => fakeWslConnects(connectLogFile).length, { timeout: 60_000 })
        .toBeGreaterThan(connectsBeforeStop)
      await expect(chat).toBeVisible({ timeout: 60_000 })
      await send('after the distro restarted')
      await expectReplyAfter('after the distro restarted')
      await page.screenshot({ path: testInfo.outputPath('wsl-host-chat-after-boot.png') })
    } finally {
      await desktop.dispose()
      rmSync(fakeDir, { recursive: true, force: true })
      rmSync(projectPath, { recursive: true, force: true })
    }
  })
})
