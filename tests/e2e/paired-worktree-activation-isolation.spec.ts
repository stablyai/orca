import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { worktreeRowSurface } from './worktree-row-locators'
import { callEnvironment } from './helpers/paired-host-terminal'

test('remote CLI creation updates the catalog while a paired desktop stays in its local workspace', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const hostRepoId = await orcaPage.evaluate(() => window.__store!.getState().repos[0].id)
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'Navigation host'
  )
  try {
    const localId = await client.page.evaluate(async (repoPath) => {
      const store = window.__store!
      await store.getState().setActiveRuntimeEnvironmentPreference(null)
      const added = await window.api.repos.add({ path: repoPath, displayName: 'My local work' })
      if ('error' in added) {
        throw new Error(added.error)
      }
      await store.getState().fetchReposForAllHosts()
      await store.getState().fetchWorktrees(added.repo.id, { forceLocalOwner: true })
      store.getState().setVisibleWorkspaceHostIds(null)
      const worktree = store
        .getState()
        .worktreesByRepo[added.repo.id]?.find((row) => row.isMainWorktree)
      if (!worktree) {
        throw new Error('Local checkout missing')
      }
      return worktree.id
    }, testRepoPath)
    await worktreeRowSurface(client.page, localId).click()
    const active = client.page.locator('[data-rendered-active-worktree-id]')
    await expect(active).toHaveAttribute('data-rendered-active-worktree-id', localId)
    const sidebar = client.page.locator('[data-worktree-sidebar]')
    const beforeScroll = await sidebar.evaluate((element) => element.scrollTop)
    await client.page.screenshot({ path: testInfo.outputPath('before-remote-create.png') })

    const name = `remote-cli-${Date.now()}`
    await callEnvironment(client.page, client.environmentId, 'worktree.create', {
      repo: hostRepoId,
      name,
      displayName: name,
      displayNameKind: 'user',
      activate: true,
      setupDecision: 'skip',
      navigation: 'all',
      cliProvenanceRequest: {}
    })

    const createdTitle = sidebar
      .locator('[data-worktree-title-inline-rename]')
      .filter({ hasText: name })
    await expect(createdTitle).toBeVisible({ timeout: 30_000 })
    await expect(active).toHaveAttribute('data-rendered-active-worktree-id', localId)
    expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(beforeScroll)
    await client.page.screenshot({ path: testInfo.outputPath('after-remote-create.png') })

    // A deliberate click can still open the newly synchronized remote workspace.
    await createdTitle.click()
    await expect(active).not.toHaveAttribute('data-rendered-active-worktree-id', localId)
    await expect(sidebar.locator('[aria-current="page"]')).toContainText(name)
  } finally {
    await client.dispose()
  }
})
