// New folder/discovered worktrees without WorktreeMeta formerly fell back to lastActivityAt:0 and sorted last in Recent.
// Require worktrees:listDetected to stamp first discovery without restamping later refreshes.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

async function addFolderRepo(page: Page, folderPath: string): Promise<string> {
  return page.evaluate(async (p) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    // Use public addNonGitFolder so internal worktree fetch triggers discovery exactly as Add Folder does.
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
  // Scope fixture tracking to this describe so future parallel tests/describes cannot share mutable cleanup arrays.
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
    // Clean mkdtemp fixtures explicitly, matching app/restart fixtures.
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

    // Require >0 to catch the original zero fallback without cross-process clock-skew comparisons.
    expect(lastActivityAt).toBeGreaterThan(0)
  })

  test('leaves lastActivityAt stable across repeated list refreshes', async ({ orcaPage }) => {
    // Refetch must retain the first-discovery stamp or sidebar refresh reshuffles Recent.
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
