/**
 * An older session names a tab's terminal on the tab alone, with no per-pane binding. After an
 * upgrade relaunch each such tab must reattach to its still-running terminal, including one left
 * unvisited for a whole run, instead of starting a new shell and orphaning the old one.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { openProfileStateDatabaseReadOnly } from '../../src/main/persistence/profile-state/profile-state-database'
import { readProfileStateSnapshot } from '../../src/main/persistence/profile-state/profile-state-documents'
import { acquireProfileStateMaintenance } from '../../src/main/persistence/profile-state/profile-state-access'
import { rollbackProfileState } from '../../src/main/persistence/profile-state/profile-state-recovery-command'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, switchToWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

function profileDataPath(userDataDir: string): string {
  return path.join(userDataDir, 'profiles', DEFAULT_LOCAL_ORCA_PROFILE_ID, 'orca-data.json')
}

/** Rewrites the stopped profile as an older build left it: terminals named on their tabs only. */
function seedTabLevelOnlyBindings(userDataDir: string, ptyIds: readonly string[]): void {
  const dataPath = profileDataPath(userDataDir)
  const databasePath = path.join(path.dirname(dataPath), 'profile-state.db')
  const opened = openProfileStateDatabaseReadOnly(databasePath, DEFAULT_LOCAL_ORCA_PROFILE_ID)
  let profile: { workspaceSession: WorkspaceSessionState }
  try {
    profile = JSON.parse(readProfileStateSnapshot(opened.db).json)
  } finally {
    opened.db.close()
  }
  const session = profile.workspaceSession
  const seeded = Object.values(session.tabsByWorktree)
    .flat()
    .filter((tab) => tab.ptyId && ptyIds.includes(tab.ptyId))
  expect(seeded.map((tab) => tab.ptyId).sort()).toEqual([...ptyIds].sort())
  for (const tab of seeded) {
    delete session.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
  }
  writeFileSync(dataPath, `${JSON.stringify(profile, null, 2)}\n`)
  const maintenance = acquireProfileStateMaintenance(userDataDir)
  try {
    rollbackProfileState(userDataDir, { kind: 'current-json' }, maintenance)
  } finally {
    maintenance.release()
  }
}

async function createWorktree(page: Page, name: string): Promise<string> {
  return page.evaluate(async (worktreeName) => {
    const state = window.__store!.getState()
    const repoId = state.allWorktrees()[0]?.repoId
    if (!repoId) {
      throw new Error('seed repo was not loaded')
    }
    return (await state.createWorktree(repoId, worktreeName, undefined, 'skip')).worktree.id
  }, name)
}

async function showTerminal(page: Page, worktreeId: string): Promise<string> {
  await switchToWorktree(page, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  return waitForActivePanePtyId(page, 30_000)
}

/** The worktree's pane is on its old terminal, which still answers. */
async function expectReattached(page: Page, worktreeId: string, ptyId: string): Promise<void> {
  await switchToWorktree(page, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const shown = await waitForActivePanePtyId(page, 30_000)
  if (shown !== ptyId) {
    // A fresh shell here leaves the old terminal running with no pane: orphaned.
    const live = await page.evaluate(() => window.api.pty.listSessions())
    const oldAlive = live.some((listed) => listed.id === ptyId)
    console.log(
      `[tab-level] pane shows ${shown}, expected ${ptyId}; old still running: ${oldAlive}`
    )
  }
  await expect.poll(() => waitForActivePanePtyId(page, 30_000), { timeout: 30_000 }).toBe(ptyId)
  const marker = `TAB_LEVEL_REATTACHED_${Date.now()}`
  await execInTerminal(page, ptyId, `echo ${marker}`)
  await waitForTerminalOutput(page, marker, 30_000)
}

test('terminals named only on their tabs reattach after an upgrade relaunch, and again after the next', async (// oxlint-disable-next-line no-empty-pattern -- this upgrade test owns its Electron launches.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Seeded E2E repository is unavailable')

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    const visited = await attachRepoAndOpenTerminal(first.page, repoPath)
    const visitedPty = await showTerminal(first.page, visited)
    const unvisited = await createWorktree(first.page, `tab-level-unvisited-${Date.now()}`)
    const unvisitedPty = await showTerminal(first.page, unvisited)
    await switchToWorktree(first.page, visited)
    // Long enough for the window's debounced save and main's bindings to land.
    await first.page.waitForTimeout(2_000)
    await session.close(app)
    app = null
    seedTabLevelOnlyBindings(session.userDataDir, [visitedPty, unvisitedPty])

    // The upgrade run shows only the active worktree; the other stays unvisited.
    const upgrade = await session.launch()
    app = upgrade.app
    await waitForSessionReady(upgrade.page)
    await expectReattached(upgrade.page, visited, visitedPty)
    await upgrade.page.waitForTimeout(2_000)
    await session.close(app)
    app = null

    const next = await session.launch()
    app = next.app
    await waitForSessionReady(next.page)
    await expectReattached(next.page, unvisited, unvisitedPty)
    await expectReattached(next.page, visited, visitedPty)
  } finally {
    if (app) {
      await session.close(app).catch(() => {})
    }
    await session.dispose()
  }
})
