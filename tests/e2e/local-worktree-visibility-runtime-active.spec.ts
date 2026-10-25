// Create through the real CLI socket while a remote runtime is active; local worktrees:changed must still refresh the sidebar.
// Inject only remote selection: the old renderer routed unbound local repo fetches away and hid new worktrees until restart.

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'

test.describe('worktree visibility with a remote runtime active', () => {
  test('a CLI-created worktree appears in the sidebar while a remote runtime is active', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    const repoId = await orcaPage.evaluate(() => {
      const repos = window.__store?.getState().repos ?? []
      // Require an unbound local-host repo so active-runtime routing exercises the reported failure.
      const target = repos.find(
        (repo) => (repo.executionHostId ?? 'local') === 'local' && !repo.connectionId
      )
      if (!target) {
        throw new Error('expected a seeded local-host repo')
      }
      return target.id
    })

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const createViaCli = async (name: string): Promise<string> => {
      const response = await client.call<{ worktree: { id: string } }>('worktree.create', {
        repo: `id:${repoId}`,
        name,
        noParent: true,
        activate: false
      })
      return response.result.worktree.id
    }
    const worktreeRow = (worktreeId: string) =>
      orcaPage.locator(`[data-worktree-id=${JSON.stringify(worktreeId)}]`).first()

    // Control: creation without a remote selection must appear, proving create/notify works.
    const controlId = await createViaCli(`wt-control-${Date.now()}`)
    await expect(worktreeRow(controlId)).toBeVisible({ timeout: 15_000 })

    await orcaPage.evaluate(() => {
      window.__store?.setState((current) => {
        if (!current.settings) {
          throw new Error('Settings are not hydrated')
        }
        return {
          settings: { ...current.settings, activeRuntimeEnvironmentId: 'e2e-fake-runtime' }
        }
      })
    })

    const targetId = await createViaCli(`wt-runtime-active-${Date.now()}`)
    await expect(
      worktreeRow(targetId),
      'a CLI-created worktree must appear even while a remote runtime is active'
    ).toBeVisible({ timeout: 15_000 })
  })
})
