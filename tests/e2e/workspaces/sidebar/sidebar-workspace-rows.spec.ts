import 'node:fs'

import 'node:os'

import 'node:path'

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { createRestartSession } from '../../desktop/electron-fixtures/orca-restart'
import { seedRelayEraProfile } from '../../remote/managed-ssh/host-lifecycle/orcad-upgrade-profile'
import { mutateStoppedProfileState } from '../../desktop/electron-fixtures/persisted-profile-state'
import { SIDEBAR_INPUTS_BUILD } from './sidebar-inputs-build'
import {
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from '../../desktop/renderer-probes/store'
import { DesktopSidebarFactsSchema } from '../../../../src/shared/sidebar-list/feed-facts/desktop-sidebar-facts'
import {
  WorkspaceRowsSnapshotSchema,
  type WorkspaceRow
} from '../../../../src/shared/sidebar-list/feed-facts/workspace-rows'

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
