/**
 * Regression: a worktree created via the CLI (`orca worktree
 * create`) must appear in the sidebar even while a remote runtime is active.
 *
 * The faithful trigger is the real CLI path — the RuntimeClient connects to the
 * running app's socket and calls `worktree.create`, which registers a managed
 * worktree and fires the `worktrees:changed` IPC the renderer listens for.
 * Before the fix, the renderer dropped that IPC whenever a remote runtime was
 * active (an unbound repo's list fetch would route to the runtime), so the
 * worktree never appeared until an app restart. The "remote runtime active"
 * condition is injected into the renderer store, so no real remote host is
 * needed.
 */

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
      // This case reproduces only for a local-host repo — one whose execution
      // host resolves to local (executionHostId unset or 'local') and which has
      // no connection binding. That is the repo whose list fetch an active
      // runtime would otherwise route away from local. Select it explicitly so
      // a future fixture change can't silently drop coverage.
      const target = repos.find(
        (repo) => (repo.executionHostId ?? 'local') === 'local' && !repo.connectionId
      )
      if (!target) {
        throw new Error('expected a seeded local-host repo')
      }
      return target.id
    })

    // The CLI talks to the running app over the socket recorded in its userData
    // dir — exactly what `orca worktree create` does from a terminal.
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

    // Guard: with no runtime active, a CLI-created worktree appears. This proves
    // the create+notify path works, so the assertion below isolates the bug
    // rather than masking a broken harness as a fixed regression.
    const controlId = await createViaCli(`wt-control-${Date.now()}`)
    await expect(worktreeRow(controlId)).toBeVisible({ timeout: 15_000 })

    // Stage a remote runtime as active — the condition that triggered the drop.
    await orcaPage.evaluate(() => {
      window.__store?.setState((current) => ({
        settings: { ...current.settings, activeRuntimeEnvironmentId: 'e2e-fake-runtime' }
      }))
    })

    // The fix: a CLI-created worktree must still appear, with no app restart.
    const targetId = await createViaCli(`wt-runtime-active-${Date.now()}`)
    await expect(
      worktreeRow(targetId),
      'a CLI-created worktree must appear even while a remote runtime is active'
    ).toBeVisible({ timeout: 15_000 })
  })
})
