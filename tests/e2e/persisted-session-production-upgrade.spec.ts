import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { PTY_SESSION_ID_SEPARATOR } from '../../src/shared/pty-session-id-format'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  discoverActivePtyId,
  execInTerminal,
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'persisted-sessions',
  'legacy-workspace-session-daemon-terminal.json'
)
// This fixture captures a legacy production schema boundary; the test runs the current build.
const RESTORED_TITLE = 'Production agent session'

type FixtureSession = {
  _fixtureProvenance?: unknown
  activeRepoId: string
  activeWorktreeId: string
  tabsByWorktree: Record<string, { ptyId: string; worktreeId: string }[]>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  activeWorktreeIdsOnShutdown?: string[]
  activeTabIdByWorktree?: Record<string, string>
}

function installProductionSessionFixture(
  userDataDir: string,
  repoId: string,
  worktreeId: string,
  ptyId: string
): void {
  const profilePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as FixtureSession
  const fixtureTabs = fixture.tabsByWorktree.__WORKTREE_ID__
  const fixtureLayout = fixture.terminalLayoutsByTabId['production-agent-tab']
  if (!fixtureTabs || !fixtureLayout) {
    throw new Error('Production session fixture is missing its terminal records')
  }
  delete fixture._fixtureProvenance
  fixture.activeRepoId = repoId
  fixture.activeWorktreeId = worktreeId
  fixture.tabsByWorktree = {
    [worktreeId]: fixtureTabs.map((tab) => ({
      ...tab,
      ptyId,
      worktreeId
    }))
  }
  fixtureLayout.ptyIdsByLeafId = {
    'pane:production-agent': ptyId
  }
  fixture.activeWorktreeIdsOnShutdown = [worktreeId]
  fixture.activeTabIdByWorktree = { [worktreeId]: 'production-agent-tab' }
  profile.workspaceSession = fixture
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)
}

async function expectProductionSessionRestored(
  page: Page,
  expected: { marker: string; ptyId: string; repoId: string; worktreeId: string }
): Promise<void> {
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, 1, 30_000)
  await waitForTerminalOutput(page, expected.marker, 30_000)

  await expect(
    page.locator('[data-testid="sortable-tab"]').filter({ hasText: RESTORED_TITLE })
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
  await expect(page.locator('.xterm').first()).toBeVisible()
  expect(await discoverActivePtyId(page)).toBe(expected.ptyId)
  expect(await getTerminalContent(page)).toContain(expected.marker)
  expect(
    await page.evaluate(() => {
      const state = window.__store?.getState()
      return {
        activeRepoId: state?.activeRepoId,
        activeWorktreeId: state?.activeWorktreeId,
        tabIds: state?.activeWorktreeId
          ? state.tabsByWorktree[state.activeWorktreeId]?.map((tab) => tab.id)
          : []
      }
    })
  ).toEqual({
    activeRepoId: expected.repoId,
    activeWorktreeId: expected.worktreeId,
    tabIds: ['production-agent-tab']
  })
}

test('upgrades a legacy daemon session and keeps it stable after relaunch', async (// oxlint-disable-next-line no-empty-pattern -- this upgrade test owns its Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repository is unavailable')

  const session = createRestartSession(testInfo)
  let oldApp: ElectronApplication | null = null
  let currentApp: ElectronApplication | null = null
  let stableApp: ElectronApplication | null = null

  try {
    const oldLaunch = await session.launch()
    oldApp = oldLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(oldLaunch.page, repoPath)
    await waitForSessionReady(oldLaunch.page)
    await ensureTerminalVisible(oldLaunch.page)
    await waitForActiveTerminalManager(oldLaunch.page, 30_000)
    await waitForPaneCount(oldLaunch.page, 1, 30_000)

    const ptyId = await discoverActivePtyId(oldLaunch.page)
    expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)
    const marker = `PRODUCTION_UPGRADE_${Date.now()}`
    await execInTerminal(oldLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(oldLaunch.page, marker)
    const repoId = await oldLaunch.page.evaluate(
      (repoPath) => window.__store?.getState().repos.find((repo) => repo.path === repoPath)?.id,
      repoPath
    )
    if (!repoId) {
      throw new Error('Active repository was unavailable before fixture installation')
    }

    await session.close(oldApp)
    oldApp = null
    installProductionSessionFixture(session.userDataDir, repoId, worktreeId, ptyId)

    const currentLaunch = await session.launch()
    currentApp = currentLaunch.app
    const expected = { marker, ptyId, repoId, worktreeId }
    await expectProductionSessionRestored(currentLaunch.page, expected)

    await session.close(currentApp)
    currentApp = null

    const stableLaunch = await session.launch()
    stableApp = stableLaunch.app
    await expectProductionSessionRestored(stableLaunch.page, expected)
  } finally {
    for (const app of [stableApp, currentApp, oldApp]) {
      if (app) {
        await session.close(app).catch(() => {})
      }
    }
    await session.dispose()
  }
})
