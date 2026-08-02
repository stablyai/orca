import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedWebClient, type PairedWebClient } from './helpers/paired-electron-client'
import { runPairedTerminalColdActivationOracle } from './helpers/paired-terminal-cold-activation-oracle'
import { runPairedTerminalParkingOracle } from './helpers/paired-terminal-parking-oracle'

test('ordinary-parks paired terminals against an isolated headless Orca host', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedWebClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedWebClient(host.app, host.offer, {
      terminalParkingDelayMs: 100
    })
    await expect
      .poll(
        () =>
          client?.page.evaluate(() => {
            const state = window.__store?.getState()
            const worktree = state?.allWorktrees()[0]
            return worktree ? { id: worktree.id, repoId: worktree.repoId } : null
          }) ?? null,
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const seed = await client.page.evaluate(() => {
      const worktree = window.__store?.getState().allWorktrees()[0]
      if (!worktree) {
        throw new Error('Headless paired client did not receive the host worktree')
      }
      return { fallbackWorktreeId: worktree.id, repoId: worktree.repoId }
    })
    await runPairedTerminalParkingOracle(client.page, seed)
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})

test('cold-activates only visible paired terminals against an isolated headless host', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedWebClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ totalCount: number }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          return listed.result.totalCount
        },
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)
    client = await launchPairedWebClient(host.app, host.offer, {
      terminalParkingDelayMs: 100
    })
    await runPairedTerminalColdActivationOracle(client.page, { repoId: added.result.repo.id })
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
