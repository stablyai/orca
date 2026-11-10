// STA-12076: profile switches relisted checkouts under new project IDs, leaving duplicate orphan rows on paired desktops.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'

type ListedRow = { repoId: string; repoKnown: boolean }

function readListedRows(page: Page, repoPath: string): Promise<ListedRow[]> {
  return page.evaluate((target) => {
    const state = window.__store?.getState()
    if (!state) {
      return []
    }
    const repoIds = new Set(state.repos.map((repo) => repo.id))
    return state
      .allWorktrees()
      .filter((worktree) => worktree.path === target)
      .map((worktree) => ({ repoId: worktree.repoId, repoKnown: repoIds.has(worktree.repoId) }))
  }, repoPath)
}

test('a server that relists its checkout under a new project id shows the workspace once', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  try {
    const projectKind = 'git' as const
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: projectKind
    })
    const oldRepoId = added.result.repo.id
    const desktop = await launchPairedElectronClient(host.offer, testInfo, 'repo id change')
    try {
      const page = desktop.page
      await expect
        .poll(() => readListedRows(page, testRepoPath), { timeout: 60_000 })
        .toEqual([{ repoId: oldRepoId, repoKnown: true }])

      // The switched-to profile's catalog: the same checkout under a project id the desktop never saw.
      await host.client.call('repo.rm', { repo: `id:${oldRepoId}` })
      const readded = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: projectKind
      })
      const newRepoId = readded.result.repo.id
      expect(newRepoId).not.toBe(oldRepoId)

      await expect
        .poll(() => readListedRows(page, testRepoPath), { timeout: 60_000 })
        .toEqual([{ repoId: newRepoId, repoKnown: true }])
    } finally {
      await desktop.dispose()
    }
  } finally {
    await host.dispose()
  }
})
