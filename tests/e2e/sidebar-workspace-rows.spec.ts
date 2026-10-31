import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { seedRelayEraProfile } from './helpers/orcad-upgrade-profile'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { waitForSessionReady, waitForStartupWorktreeRefresh } from './helpers/store'
import { DesktopSidebarFactsSchema } from '../../src/shared/sidebar-list/desktop-sidebar-facts'
import {
  WorkspaceRowsSnapshotSchema,
  type WorkspaceRow
} from '../../src/shared/sidebar-list/workspace-rows'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'main publishes sidebar inputs only in an ORCA_SIDEBAR_INPUTS=main build'
)

async function readMainRows(page: Page): Promise<Record<string, WorkspaceRow>> {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.workspaceRows' })
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.workspaceRows failed')
  }
  return WorkspaceRowsSnapshotSchema.parse(response.result).rows
}

test('main lists the window’s git and folder workspaces and follows its metadata writes', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  await waitForSessionReady(orcaPage)
  await waitForStartupWorktreeRefresh(orcaPage)
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-workspace-rows-')))
  registerPostElectronShutdownCleanup(async () =>
    rmSync(folderPath, { recursive: true, force: true })
  )

  const { worktreeId, folderKey } = await orcaPage.evaluate(async (parentPath) => {
    const store = window.__store!
    const group = await window.api.projectGroups.create({
      name: 'Rows folder project',
      parentPath,
      createdFrom: 'folder-scan'
    })
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
    const folder = await store
      .getState()
      .createFolderWorkspace(
        { projectGroupId: group.id, name: 'Rows folder', folderPath: parentPath },
        { runtimeEnvironmentId: null }
      )
    const repo = store.getState().repos[0]
    const worktree = repo ? store.getState().worktreesByRepo[repo.id]?.[0] : undefined
    if (!folder || !worktree) {
      throw new Error('Expected a seeded worktree and a folder workspace')
    }
    return { worktreeId: worktree.id, folderKey: `local|folder:${folder.id}` }
  }, folderPath)
  const rowKey = `local|${worktreeId}`

  await expect.poll(async () => Object.keys(await readMainRows(orcaPage))).toContain(folderKey)
  const before = (await readMainRows(orcaPage))[rowKey]
  expect(before).toMatchObject({ kind: 'git', hostId: 'local', isPinned: false })

  // The window writes metadata without announcing it; main must still follow.
  await orcaPage.evaluate(
    (id) => window.__store!.getState().updateWorktreeMeta(id, { isPinned: true, comment: 'rows' }),
    worktreeId
  )
  await orcaPage.evaluate(
    (id) => window.__store!.getState().updateFolderWorkspace(id, { isPinned: true }),
    folderKey.slice('local|folder:'.length)
  )
  await expect
    .poll(async () => {
      const rows = await readMainRows(orcaPage)
      return [rows[rowKey]?.isPinned, rows[rowKey]?.comment, rows[folderKey]?.isPinned]
    })
    .toEqual([true, 'rows', true])
})

test('a disconnected SSH host keeps its rows, and its state reads not connected', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(3 * 60_000)
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    app = first.app
    await waitForSessionReady(first.page)
    await session.close(app)
    app = null
    // Nothing listens on port 1, so the host never answers.
    const seeded = seedRelayEraProfile(
      session.userDataDir,
      { label: 'Unreachable', host: '127.0.0.1', port: 1, username: 'nobody' },
      { repoPath: '/srv/rows-repo', folderPath: '/srv/rows-folders' }
    )
    const hostId = `ssh:${seeded.targetId}`
    // Its rows are the ones it stored: here one pinned workspace.
    mutateStoppedProfileState(session.userDataDir, (state) => {
      state.worktreeMeta = {
        ...(state.worktreeMeta && typeof state.worktreeMeta === 'object' ? state.worktreeMeta : {}),
        [`${seeded.repoId}::/srv/rows-repo/feature`]: {
          hostId,
          instanceId: 'ssh-rows-feature',
          displayName: 'Remote feature',
          isPinned: true
        }
      }
    })
    const launched = await session.launch()
    app = launched.app
    const page = launched.page
    await waitForSessionReady(page)
    await waitForStartupWorktreeRefresh(page)
    await expect
      .poll(async () =>
        Object.values(await readMainRows(page))
          .filter((row) => row.hostId === hostId)
          .map((row) => [row.kind, row.displayName, row.isPinned])
          .sort()
      )
      .toEqual([
        ['folder', 'orcad upgrade folder', false],
        ['git', 'Remote feature', true]
      ])
    const facts = await page.evaluate(() =>
      window.api.runtime.call({ method: 'sidebarInputs.desktopFacts' })
    )
    if (!facts.ok) {
      throw new Error('sidebarInputs.desktopFacts failed')
    }
    expect(
      DesktopSidebarFactsSchema.parse(facts.result).sshHosts[seeded.targetId]?.status
    ).not.toBe('connected')
  } finally {
    await session.dispose(app ?? undefined)
  }
})
