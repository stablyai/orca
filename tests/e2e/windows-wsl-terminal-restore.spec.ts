import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { buildWslExecArgs } from '../../src/shared/wsl-login-shell-command'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { useWslRuntimeForActiveProject as selectWslRuntimeForActiveProject } from './helpers/wsl-golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const REQUIRE_WSL_RESTORE = process.env.ORCA_REQUIRE_WSL_RESTORE_E2E === '1'

type WslRestoreSnapshot = {
  hostCwd: string
  ptyId: string
  sessionIds: string[]
  shellOverride: string | undefined
  tabIds: string[]
}

function getGuestPath(distro: string, hostPath: string): string {
  return execFileSync('wsl.exe', buildWslExecArgs(distro, ['wslpath', '-a', hostPath]), {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 15_000,
    windowsHide: true
  }).trim()
}

async function createWslStartupTab(
  page: Page,
  worktreeId: string,
  distro: string,
  marker: string
): Promise<string> {
  await selectWslRuntimeForActiveProject(page, distro)
  return page.evaluate(
    ({ worktreeId, marker }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const tab = store.getState().createTab(worktreeId, undefined, undefined, {
        pendingStartup: {
          command: `printf '${marker}:%s\\n' "$PWD"`,
          delivery: 'terminal-paste'
        }
      })
      store.getState().setActiveTab(tab.id)
      store.getState().setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, marker }
  )
}

async function readSnapshot(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<WslRestoreSnapshot> {
  return page.evaluate(
    async ({ worktreeId, tabId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tabId
      )
      const ptyIds = state.ptyIdsByTabId[tabId] ?? []
      if (!tab || ptyIds.length !== 1) {
        throw new Error(`Expected one PTY for restored WSL tab ${tabId}`)
      }
      const sessions = await window.api.pty.listSessions()
      const ownedSession = sessions.find((session) => session.id === ptyIds[0])
      if (!ownedSession) {
        throw new Error(`WSL PTY ${ptyIds[0]} was absent from provider inventory`)
      }
      return {
        hostCwd: ownedSession.cwd,
        ptyId: ptyIds[0]!,
        sessionIds: sessions.map((session) => session.id).sort(),
        shellOverride: tab.shellOverride,
        tabIds: (state.tabsByWorktree[worktreeId] ?? []).map((candidate) => candidate.id).sort()
      }
    },
    { worktreeId, tabId }
  )
}

async function waitForRestoredWslTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await waitForSessionReady(page, 60_000)
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 60_000 }).toBe(worktreeId)
  await ensureTerminalVisible(page)
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    state?.setActiveTab(tabId)
    state?.setActiveTabType('terminal')
  }, tabId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

test('WSL terminal preserves guest cwd, liveness, and PTY ownership across relaunch', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both Electron launches.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'WSL restore coverage requires a Windows host')
  test.setTimeout(300_000)

  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  if (!repoPath || !existsSync(repoPath)) {
    if (REQUIRE_WSL_RESTORE) {
      throw new Error('Required WSL restore E2E seeded repo is unavailable')
    }
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const restart = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await restart.launch()
    app = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)

    const distro = await first.page.evaluate(async () => {
      if (!(await window.api.wsl.isAvailable())) {
        return null
      }
      return (await window.api.wsl.listDistros())[0] ?? null
    })
    if (!distro) {
      if (REQUIRE_WSL_RESTORE) {
        throw new Error('Required Windows WSL distro is unavailable')
      }
      test.skip(true, 'No WSL distro is available on this Windows host')
      return
    }

    const guestPath = getGuestPath(distro, repoPath)
    const startupMarker = `WSL_RESTORE_STARTUP_${randomUUID().replaceAll('-', '_')}`
    const tabId = await createWslStartupTab(first.page, worktreeId, distro, startupMarker)
    await waitForActiveTerminalManager(first.page, 60_000)
    const firstPtyId = await waitForActivePanePtyId(first.page, 60_000)
    await waitForTerminalOutput(first.page, `${startupMarker}:${guestPath}`, 30_000)

    const baseline = await readSnapshot(first.page, worktreeId, tabId)
    expect(baseline.hostCwd).toBe(repoPath)
    expect(baseline.ptyId).toBe(firstPtyId)
    expect(baseline.shellOverride).toBe('wsl.exe')
    await expect(
      first.page.evaluate((ptyId) => window.api.pty.hasPty(ptyId), firstPtyId)
    ).resolves.toBe(true)

    await first.page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await expect
      .poll(
        () =>
          first.page.evaluate(
            async ({ worktreeId, tabId, ptyId }) => {
              const persisted = await window.api.session.get()
              const tab = (persisted.tabsByWorktree[worktreeId] ?? []).find(
                (candidate) => candidate.id === tabId
              )
              const layoutPtyId = persisted.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId
                ? Object.values(persisted.terminalLayoutsByTabId[tabId]!.ptyIdsByLeafId!)[0]
                : undefined
              return tab?.id === tabId && layoutPtyId === ptyId
            },
            { worktreeId, tabId, ptyId: firstPtyId }
          ),
        { timeout: 15_000, message: 'WSL tab ownership was not persisted before quit' }
      )
      .toBe(true)

    await restart.close(app)
    app = null
    const second = await restart.launch()
    app = second.app
    await waitForRestoredWslTab(second.page, worktreeId, tabId)
    await waitForTerminalOutput(second.page, `${startupMarker}:${guestPath}`, 30_000)

    const restored = await readSnapshot(second.page, worktreeId, tabId)
    expect(restored).toEqual(baseline)
    await expect(
      second.page.evaluate((ptyId) => window.api.pty.hasPty(ptyId), restored.ptyId)
    ).resolves.toBe(true)

    const inputMarker = `WSL_RESTORE_INPUT_${randomUUID().replaceAll('-', '_')}`
    await execInTerminal(second.page, restored.ptyId, `printf '${inputMarker}:%s\\n' "$PWD"`)
    await waitForTerminalOutput(second.page, `${inputMarker}:${guestPath}`, 30_000)
    expect(await getTerminalContent(second.page)).toContain(`${inputMarker}:${guestPath}`)
  } finally {
    if (app) {
      await restart.close(app)
    }
    await restart.dispose()
  }
})
