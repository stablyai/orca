/**
 * A journaled Windows-drive conversion on a real desktop: a project kept at WSL's view of a drive
 * (`\\wsl.localhost\Ubuntu\mnt\c\…`), with a slept terminal and a worktree comment, opens at the
 * drive path after the restart. Its settings and its terminal's saved session follow the new
 * worktree id, and the journal goes once the window has converted its own stores.
 *
 * Starting a conversion needs Windows; running a journaled one does not, so this runs anywhere.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import { waitForSessionReady } from './helpers/store'
import { getHistorySessionDirName } from '../../src/main/daemon/history-paths'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion
} from '../../src/main/wsl/wsl-drive-unc-conversion-journal'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../src/shared/wsl-host-internal-gate'

test.use({ seedTestRepo: false })

const SavedProfile = z.object({
  worktreeMeta: z.record(z.string(), z.object({ comment: z.string().optional() })),
  workspaceSession: z.object({
    tabsByWorktree: z.record(z.string(), z.array(z.object({ ptyId: z.string().nullable() })))
  }),
  projects: z.array(
    z.object({ sourceRepoIds: z.array(z.string()), localWindowsRuntimePreference: z.unknown() })
  )
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const DRIVE = String.raw`C:\src\app`
const OLD_ID = `repo-unc::${UNC}`
const NEW_ID = `repo-unc::${DRIVE}`

test('a journaled conversion reopens a UNC drive project at its drive path', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  const session = createRestartSession(testInfo, { [WSL_HOSTS_INTERNAL_GATE_ENV]: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | undefined
  try {
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    await session.close(launched.app)
    launched = undefined

    mutateStoppedProfileState(session.userDataDir, (state) => {
      state.repos = [
        { id: 'repo-unc', path: UNC, displayName: 'app', badgeColor: '#000000', addedAt: 1 }
      ]
      state.worktreeMeta = {
        [OLD_ID]: {
          displayName: 'app',
          comment: 'half-way through the refactor',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1
        }
      }
      state.workspaceSession = {
        ...(isRecord(state.workspaceSession) ? state.workspaceSession : {}),
        tabsByWorktree: {
          [OLD_ID]: [
            {
              id: 'tab-unc',
              ptyId: `${OLD_ID}@@slept`,
              worktreeId: OLD_ID,
              title: 'shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      }
    })
    // The slept pane's daemon session, as Sleep leaves it.
    const oldSession = join(
      session.userDataDir,
      'terminal-history',
      getHistorySessionDirName(`${OLD_ID}@@slept`)
    )
    mkdirSync(oldSession, { recursive: true })
    writeFileSync(join(oldSession, 'meta.json'), JSON.stringify({ cwd: '/mnt/c/src/app' }))
    writeWslDriveUncConversion(session.userDataDir, {
      version: 1,
      migrationId: 'conversion-e2e',
      distro: 'Ubuntu',
      repoIds: ['repo-unc'],
      folderWorkspaceIds: [],
      rootPaths: [UNC],
      phase: 'prepared',
      worktreeIds: [[OLD_ID, NEW_ID]],
      rewrittenStores: [],
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z'
    })

    launched = await session.launch()
    await waitForSessionReady(launched.page)
    const repos = await launched.page.evaluate(() => window.api.repos.list())
    expect(repos.find((repo) => repo.id === 'repo-unc')?.path).toBe(DRIVE)
    expect(
      existsSync(
        join(session.userDataDir, 'terminal-history', getHistorySessionDirName(`${NEW_ID}@@slept`))
      )
    ).toBe(true)
    // The window converts its own stores, then the journal goes.
    await expect
      .poll(() => listWslDriveUncConversions(session.userDataDir).length, { timeout: 20_000 })
      .toBe(0)
    await session.close(launched.app)
    launched = undefined

    const saved = SavedProfile.parse(readPersistedProfileState(session.userDataDir))
    expect(saved.worktreeMeta[NEW_ID]?.comment).toBe('half-way through the refactor')
    expect(saved.worktreeMeta[OLD_ID]).toBeUndefined()
    // The tab itself isn't checked: off Windows `C:\src\app` never exists, so the window drops
    // its tabs as a missing workspace's. The unit tests check the re-keyed session.
    expect(saved.workspaceSession.tabsByWorktree[OLD_ID]).toBeUndefined()
    expect(
      saved.projects.find((project) => project.sourceRepoIds.includes('repo-unc'))
        ?.localWindowsRuntimePreference
    ).toEqual({ kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' })
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
  }
})
