import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, getActiveWorktreeId, waitForSessionReady } from './helpers/store'
import { TEST_REPO_PATH_FILE } from './global-setup'

const FIRST_SURVIVOR_TITLE = 'STA-3604 survivor one'
const SECOND_SURVIVOR_TITLE = 'STA-3604 survivor two'
const CORRUPT_TAB_ID = 'sta-3604-corrupt-tab'

type PersistedData = {
  workspaceSession?: {
    tabsByWorktree?: Record<string, Record<string, unknown>[]>
    unifiedTabs?: Record<string, Record<string, unknown>[]>
  }
}

function persistedDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

function injectTruncatedTab(userDataDir: string, worktreeId: string, startupCwd: string): void {
  const dataPath = persistedDataPath(userDataDir)
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as PersistedData
  const tabs = data.workspaceSession?.tabsByWorktree?.[worktreeId]
  if (!tabs) {
    throw new Error('Persisted terminal tabs were unavailable for corruption seeding')
  }
  tabs.push({
    id: CORRUPT_TAB_ID,
    ptyId: null,
    worktreeId,
    title: 'Truncated terminal',
    sortOrder: 999,
    generation: 3,
    startupCwd
  })
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`)
}

function persistedSessionEvidence(
  userDataDir: string,
  worktreeId: string
): { corruptLegacyTabPresent: boolean; unifiedTabIds: string[] } {
  const data = JSON.parse(readFileSync(persistedDataPath(userDataDir), 'utf8')) as PersistedData
  const legacyTabs = data.workspaceSession?.tabsByWorktree?.[worktreeId] ?? []
  const unifiedTabs = data.workspaceSession?.unifiedTabs?.[worktreeId] ?? []
  return {
    corruptLegacyTabPresent: legacyTabs.some((tab) => tab.id === CORRUPT_TAB_ID),
    unifiedTabIds: unifiedTabs
      .map((tab) => tab.id)
      .filter((id): id is string => typeof id === 'string')
  }
}

async function expectSurvivingTabsVisible(page: Page): Promise<void> {
  for (const title of [FIRST_SURVIVOR_TITLE, SECOND_SURVIVOR_TITLE]) {
    await expect(
      page.locator('[data-testid="sortable-tab"]').filter({ hasText: title })
    ).toBeVisible({ timeout: 15_000 })
  }
}

test('keeps valid terminal tabs visible after a corrupt sibling record on restart', async (// oxlint-disable-next-line no-empty-pattern -- this restart test owns its Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repository is unavailable')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await ensureTerminalVisible(first.page)

    const survivorIds = await first.page.evaluate(
      ({ worktreeId, firstTitle, secondTitle }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Renderer store unavailable')
        }
        const state = store.getState()
        const firstTab = state.tabsByWorktree[worktreeId]?.[0]
        if (!firstTab) {
          throw new Error('Initial terminal tab unavailable')
        }
        state.setTabCustomTitle(firstTab.id, firstTitle)
        const secondTab = state.createTab(worktreeId, undefined, undefined, { activate: false })
        state.setTabCustomTitle(secondTab.id, secondTitle)
        return [firstTab.id, secondTab.id]
      },
      { worktreeId, firstTitle: FIRST_SURVIVOR_TITLE, secondTitle: SECOND_SURVIVOR_TITLE }
    )
    await expectSurvivingTabsVisible(first.page)

    await session.close(firstApp)
    firstApp = null
    injectTruncatedTab(session.userDataDir, worktreeId, repoPath)

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await expect.poll(() => getActiveWorktreeId(second.page), { timeout: 15_000 }).toBe(worktreeId)
    await ensureTerminalVisible(second.page)

    await expectSurvivingTabsVisible(second.page)
    await expect(second.page.locator('.xterm').first()).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => persistedSessionEvidence(session.userDataDir, worktreeId), {
        timeout: 30_000
      })
      .toEqual({ corruptLegacyTabPresent: false, unifiedTabIds: survivorIds })

    await testInfo.attach('sta-3604-valid-tabs-after-corrupt-session-restart.png', {
      body: await second.page.screenshot(),
      contentType: 'image/png'
    })
    await expectSurvivingTabsVisible(second.page)
  } finally {
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})
