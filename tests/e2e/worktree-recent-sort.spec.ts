/**
 * E2E test for newly-added worktrees sorting correctly in "Recent" mode.
 *
 * Why this exists:
 *   Before the fix in `src/main/ipc/worktrees.ts`, a worktree that existed
 *   on disk but had no persisted WorktreeMeta (the case for folder-mode
 *   repos and pre-existing worktrees discovered when adding a new git repo)
 *   fell back to `lastActivityAt: 0`. "Recent" sort orders by
 *   `lastActivityAt` descending, so those worktrees landed dead last —
 *   even though the user had just added them.
 *
 *   The `worktrees:list` / `worktrees:listAll` handlers now stamp
 *   `lastActivityAt = Date.now()` on first discovery. This test locks that
 *   behavior in end-to-end.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

async function addFolderRepo(page: Page, folderPath: string): Promise<string> {
  return page.evaluate(async (p) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    // Why: go through the public addNonGitFolder path (not window.api.repos.add
    // directly) so the test exercises the same flow the "Add Folder" dialog
    // uses. That path fetches worktrees internally, which is what triggers the
    // discovery stamp we're asserting about.
    const repo = await store.getState().addNonGitFolder(p)
    if (!repo) {
      throw new Error('addNonGitFolder returned null')
    }
    return repo.id
  }, folderPath)
}

async function readFolderWorktreeLastActivity(page: Page, repoId: string): Promise<number> {
  return page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const worktree = store.getState().worktreesByRepo[id]?.[0]
    if (!worktree) {
      throw new Error(`No worktree found for repo ${id}`)
    }
    return worktree.lastActivityAt
  }, repoId)
}

test.describe('Worktree Recent Sort', () => {
  // Why: keep fixture tracking scoped to this describe block. Module-level
  // shared arrays race if the file ever flips to parallel mode or another
  // describe is added.
  const createdFolderFixtures: string[] = []

  function createFolderFixture(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-folder-'))
    createdFolderFixtures.push(dir)
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, 'README.md'), '# folder fixture\n')
    return dir
  }

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test.afterEach(() => {
    // Why: mkdtempSync fixtures leak unless we clean them up explicitly —
    // matches the mkdtempSync/rmSync pairing used in helpers/orca-app.ts
    // and helpers/orca-restart.ts.
    while (createdFolderFixtures.length) {
      const dir = createdFolderFixtures.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  test('stamps lastActivityAt on a newly-added folder repo so it sorts to the top of Recent', async ({
    orcaPage
  }) => {
    const folderPath = createFolderFixture()

    const repoId = await addFolderRepo(orcaPage, folderPath)
    const lastActivityAt = await readFolderWorktreeLastActivity(orcaPage, repoId)

    // Why: the exact failure mode before the fix was `lastActivityAt === 0`
    // (the fallback in mergeWorktree when meta is undefined). Asserting
    // `> 0` captures that regression precisely without coupling to the
    // wall-clock of the main process, which would introduce cross-process
    // clock-skew flakiness in CI.
    expect(lastActivityAt).toBeGreaterThan(0)
  })

  test('leaves lastActivityAt stable across repeated list refreshes', async ({ orcaPage }) => {
    // Why: the stamp fires only on *first* discovery. Re-fetching must not
    // overwrite it, or every sidebar refresh would reshuffle Recent order.
    const folderPath = createFolderFixture()
    const repoId = await addFolderRepo(orcaPage, folderPath)

    const first = await readFolderWorktreeLastActivity(orcaPage, repoId)

    await orcaPage.evaluate(async (id) => {
      await window.__store?.getState().fetchWorktrees(id)
      await window.__store?.getState().fetchWorktrees(id)
    }, repoId)

    const second = await readFolderWorktreeLastActivity(orcaPage, repoId)
    expect(second).toBe(first)
  })
})
