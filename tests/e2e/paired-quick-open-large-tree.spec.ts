import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { createPairedQuickOpenLargeTreeFixture } from './helpers/paired-quick-open-large-tree-fixture'
import type { PairedQuickOpenLargeTreeFixture } from './helpers/paired-quick-open-large-tree-fixture'
import { waitForSessionReady } from './helpers/store'

const QUICK_OPEN_SEARCH_DEBOUNCE_MS = 120

async function activateWorktree(page: Page, repoPath: string, timeout = 60_000): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (targetPath) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => {
                const normalize = (value: string): string =>
                  value.startsWith('/private/var/') ? value.slice('/private'.length) : value
                return normalize(worktree.path) === normalize(targetPath)
              })?.id ?? null,
          repoPath
        ),
      { timeout, message: 'paired client never received the large-tree worktree' }
    )
    .not.toBeNull()
  return page.evaluate((targetPath) => {
    const state = window.__store?.getState()
    const worktree = state?.allWorktrees().find((entry) => {
      const normalize = (value: string): string =>
        value.startsWith('/private/var/') ? value.slice('/private'.length) : value
      return normalize(entry.path) === normalize(targetPath)
    })
    if (!state || !worktree) {
      throw new Error('large-tree worktree is unavailable')
    }
    state.setActiveRepo(worktree.repoId)
    state.setActiveWorktree(worktree.id)
    return worktree.id
  }, repoPath)
}

async function openQuickOpen(page: Page): Promise<void> {
  await page.evaluate(() => window.__store?.getState().openModal('quick-open'))
  await expect(page.getByRole('dialog', { name: 'Go to file' })).toBeVisible()
}

async function expectQuickOpenAndRuntimeHealthy(
  client: PairedElectronClient,
  worktreeId: string,
  fixture: PairedQuickOpenLargeTreeFixture
): Promise<void> {
  const dialog = client.page.getByRole('dialog', { name: 'Go to file' })
  const input = dialog.getByPlaceholder('Go to file...')
  const loading = dialog.getByText('Loading files...')
  await client.page.clock.install()
  const queryOracle = async (targetPath: string) =>
    client.page.evaluate(
      async ({ environmentId, worktreeId, targetPath }) => {
        const query = targetPath.split('/').at(-1)!
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.searchPaths',
          params: { worktree: `id:${worktreeId}`, query, limit: 32, mode: 'quick-open' }
        })
        if (!response.ok) {
          throw new Error(`files.searchPaths oracle failed: ${JSON.stringify(response)}`)
        }
        const oracle = {
          files: response.result.files.map((file) => file.relativePath),
          totalCount: response.result.totalCount,
          truncated: response.result.truncated
        }
        const encodedOracle = new TextEncoder().encode(JSON.stringify(oracle))
        const digest = await crypto.subtle.digest('SHA-256', encodedOracle)
        return {
          ...oracle,
          oracleByteLength: encodedOracle.byteLength,
          wireByteLength: new TextEncoder().encode(JSON.stringify(response.result)).byteLength,
          sha256: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0')
          ).join('')
        }
      },
      { environmentId: client.environmentId, worktreeId, targetPath }
    )
  for (const targetPath of [fixture.gitIgnoredTargetPath, fixture.orcaIgnoredTargetPath]) {
    const filename = targetPath.split('/').at(-1)!
    const stat = await client.page.evaluate(
      async ({ environmentId, worktreeId, targetPath }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'files.stat',
          params: { worktree: `id:${worktreeId}`, relativePath: targetPath }
        })
        if (!response.ok) {
          throw new Error(`files.stat oracle failed: ${JSON.stringify(response)}`)
        }
        return response.result
      },
      { environmentId: client.environmentId, worktreeId, targetPath }
    )
    expect(stat.isDirectory).toBe(false)
    expect(stat.size).toBeGreaterThanOrEqual(0)

    const queryResult = await queryOracle(targetPath)
    const repeatedResult = await queryOracle(targetPath)
    console.log(
      `[STA-5209] query=${targetPath} oracle=${JSON.stringify(queryResult)} repeated=${JSON.stringify(repeatedResult)}`
    )
    expect(queryResult).toEqual(repeatedResult)
    expect(queryResult.files).toEqual([targetPath])
    expect(queryResult.totalCount).toBe(1)
    expect(queryResult.truncated).toBe(false)
    expect(queryResult.wireByteLength).toBeLessThan(4_096)
    expect(queryResult).toMatchObject(
      targetPath === fixture.gitIgnoredTargetPath
        ? {
            oracleByteLength: 95,
            sha256: 'a6259174bf63bccb04ec461aed9b316f8ef78fe0474a6a101d4f11a383414125'
          }
        : {
            oracleByteLength: 89,
            sha256: '9e7399e32001d443105e0f612f0eb2eee88fba50902dc75c926c547538e93eb5'
          }
    )

    // Why: control only the debounce; RPC deadlines and socket liveness stay on real time.
    const pauseAt = await client.page.evaluate(() => Date.now() + 1_000)
    await client.page.clock.pauseAt(pauseAt)
    await input.fill(filename.slice(0, 8))
    await input.fill(filename.slice(0, 18))
    await input.fill(filename)
    await expect(loading).toBeVisible()
    await client.page.clock.runFor(QUICK_OPEN_SEARCH_DEBOUNCE_MS)
    await client.page.clock.resume()
    await expect(dialog.getByRole('option').filter({ hasText: filename })).toHaveCount(1, {
      timeout: 60_000
    })
    await expect(loading).toHaveCount(0)
    await expect(dialog).not.toContainText('Outbound reply buffer overflow')
    await expect(dialog).not.toContainText('Remote Orca runtime closed the connection')
  }

  const response = await client.page.evaluate(
    async ({ environmentId }) =>
      window.api.runtimeEnvironments.call({
        selector: environmentId,
        method: 'worktree.list',
        params: { limit: 10_000 }
      }),
    { environmentId: client.environmentId }
  )
  expect(response.ok).toBe(true)
  if (response.ok) {
    expect(response.result.worktrees.some((worktree) => worktree.id === worktreeId)).toBe(true)
  }
}

test('finds paths beyond the old prefix on a headed paired runtime @headful', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = createPairedQuickOpenLargeTreeFixture()
  let client: PairedElectronClient | null = null
  try {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async (repoPath) => {
      const store = window.__store
      if (!store || !(await store.getState().addRepoPath(repoPath))) {
        throw new Error('headed host could not add the large-tree repo')
      }
    }, fixture.root)
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'STA-4354 headed host'
    )
    const worktreeId = await activateWorktree(client.page, fixture.root)
    await openQuickOpen(client.page)
    await expectQuickOpenAndRuntimeHealthy(client, worktreeId, fixture)
  } finally {
    await client?.dispose()
    fixture.dispose()
  }
})

test('finds paths beyond the old prefix on a headless paired runtime', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
{}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = createPairedQuickOpenLargeTreeFixture()
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: fixture.root,
      kind: 'git'
    })
    await host.client.call('repo.update', {
      repo: `id:${added.result.repo.id}`,
      updates: { externalWorktreeVisibility: 'show' }
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'STA-4354 headless host')
    const worktreeId = await activateWorktree(client.page, fixture.root, 180_000)
    await openQuickOpen(client.page)
    await expectQuickOpenAndRuntimeHealthy(client, worktreeId, fixture)
  } finally {
    await client?.dispose()
    await host.dispose()
    fixture.dispose()
  }
})
