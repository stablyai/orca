/**
 * A moved project's browser tabs and unsaved drafts, as the moving desktop sees them once the WSL
 * host owns the project. The distro's server has no browser of its own and the move never sends it
 * drafts, so both come back only from the copy of the host's session this desktop kept.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/wsl-move-host-browser-drafts.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import {
  createMovedRepo,
  MOVED_BROWSER_URL,
  movedWorkspaceRows,
  seedImportedMovedTab,
  withMovedRows
} from './helpers/wsl-moved-host-profile'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'

const DRAFT = 'unsaved words typed before the move'

test("a moved project's browser tab and draft come back on the desktop from a browserless host", async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires destructuring to request no fixtures.
{}, testInfo) => {
  test.skip(process.platform === 'win32', 'POSIX paths')
  // A host and two client launches, with a profile edit between them.
  test.setTimeout(600_000)
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-moved-browser-drafts-'))
  const repoPath = realpathSync(createMovedRepo(root))
  const notesPath = path.join(repoPath, 'notes.md')
  writeFileSync(notesPath, 'saved words\n')
  const openFile = { filePath: notesPath, relativePath: 'notes.md' }
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    withoutBrowser: true,
    // Stands in for the distro's orcad, the only host that serves moved panes' history.
    extraEnv: { ORCA_E2E_WSL_MOVE_DESTINATION: '1' }
  })
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: repoPath,
      kind: 'git'
    })
    const worktreeId = `${added.result.repo.id}::${repoPath}`
    await host.restartServeProcess({
      betweenProcesses: () =>
        seedImportedMovedTab(host.userDataDir, worktreeId, 'moved history\r\n', {
          openFiles: [openFile],
          browserTab: false
        })
    })
    const first = await launchPairedElectronClient(host.offer, testInfo, 'moved-browser-drafts')
    const { environmentId, userDataDir } = first
    let client = first
    try {
      await expect
        .poll(
          () =>
            client.page.evaluate(
              (id) =>
                Boolean(
                  window.__store
                    ?.getState()
                    .allWorktrees()
                    .some((worktree) => worktree.id === id)
                ),
              worktreeId
            ),
          { timeout: 60_000 }
        )
        .toBe(true)
      // This desktop mirrors the host's tabs before it quits, as one open before the move did.
      await expect
        .poll(
          () =>
            client.page.evaluate(
              (id) => (window.__store?.getState().unifiedTabsByWorktree[id] ?? []).length,
              worktreeId
            ),
          { timeout: 60_000, message: "the desktop never mirrored the host's tabs" }
        )
        .toBeGreaterThan(0)
      await client.quitPreservingProfile()
      // The move's seed of this desktop's copy of the host's session: browser tab and draft included.
      mutateStoppedProfileState(userDataDir, (state) => {
        const held = state.workspaceSessionsByHostId
        const partitions: Record<string, unknown> =
          held && typeof held === 'object' ? { ...held } : {}
        const hostId = toRuntimeExecutionHostId(environmentId)
        const current = partitions[hostId]
        const partition: Record<string, unknown> =
          current && typeof current === 'object' ? { ...current } : {}
        withMovedRows(
          partition,
          movedWorkspaceRows(worktreeId, {
            openFiles: [{ ...openFile, dirtyDraftContent: DRAFT }],
            runtimeEnvironmentId: environmentId
          })
        )
        state.workspaceSessionsByHostId = { ...partitions, [hostId]: partition }
      })
      client = await launchPairedElectronClient(host.offer, testInfo, 'moved-browser-drafts', {
        reuseUserDataDir: userDataDir
      })
      await client.page.evaluate((id) => {
        const state = window.__store?.getState()
        state?.setActiveView('terminal')
        state?.setActiveWorktree(id)
      }, worktreeId)
      const readMoved = () =>
        client.page.evaluate(
          ({ id, path: filePath }) => {
            const store = window.__store?.getState()
            const browserUrls = (store?.browserTabsByWorktree[id] ?? []).flatMap((workspace) =>
              (store?.browserPagesByWorkspace[workspace.id] ?? []).map((page) => page.url)
            )
            const file = store?.openFiles.find(
              (entry) => entry.worktreeId === id && entry.filePath === filePath
            )
            return {
              browserUrls,
              tabs: (store?.unifiedTabsByWorktree[id] ?? []).map((tab) => tab.contentType),
              draft: file ? (store?.editorDrafts[file.id] ?? null) : null
            }
          },
          { id: worktreeId, path: notesPath }
        )
      await expect
        .poll(async () => (await readMoved()).tabs, { timeout: 60_000 })
        .toEqual(expect.arrayContaining(['browser', 'editor']))
      const moved = await readMoved()
      console.log(`[moved-browser-drafts] ${JSON.stringify(moved)}`)
      // What the user sees: a tab for each, not only rows in the store.
      expect.soft(moved.tabs).toEqual(expect.arrayContaining(['browser', 'editor']))
      expect.soft(moved.browserUrls).toContain(MOVED_BROWSER_URL)
      expect.soft(moved.draft).toBe(DRAFT)
    } finally {
      await client.dispose()
    }
  } finally {
    await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
