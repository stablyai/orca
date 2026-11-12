import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function openWorkspaceFile(
  page: Page,
  file: {
    filePath: string
    worktreeId: string
    executionHostId: 'local' | `runtime:${string}`
    runtimeEnvironmentId: string | null
  }
): Promise<string> {
  return page.evaluate(({ filePath, worktreeId, executionHostId, runtimeEnvironmentId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Editor store unavailable')
    }
    store.getState().setActiveWorktree(worktreeId, executionHostId)
    return store.getState().openFile({
      filePath,
      relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
      worktreeId,
      runtimeEnvironmentId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, file)
}

// The same checkout path is open on the paired client's own host and on the runtime host it is paired with.
test('keeps same-path host models and undo history separate', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  // Launching and pairing a second Electron client takes most of this budget.
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const filePath = path.join(testRepoPath, `host-model-${randomUUID()}.txt`)
  await writeFile(filePath, 'MARKER', 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))

  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(orcaPage),
      testInfo,
      'Host model isolation'
    )
    const { page, environmentId } = client
    const findRemoteWorktreeId = (): Promise<string | null> =>
      page.evaluate(
        (repoPath) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.path === repoPath)?.id ?? null,
        testRepoPath
      )
    await expect.poll(findRemoteWorktreeId, { timeout: 120_000 }).not.toBeNull()
    const remoteWorktreeId = await findRemoteWorktreeId()
    if (!remoteWorktreeId) {
      throw new Error('Paired client never received the host worktree')
    }
    const localWorktreeId = await page.evaluate(async (repoPath) => {
      const store = window.__store!
      await store.getState().setActiveRuntimeEnvironmentPreference(null)
      const added = await window.api.repos.add({ path: repoPath })
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
    expect(localWorktreeId).not.toBe(remoteWorktreeId)
    const local = {
      filePath,
      worktreeId: localWorktreeId,
      executionHostId: 'local' as const,
      runtimeEnvironmentId: null
    }
    const remote = {
      filePath,
      worktreeId: remoteWorktreeId,
      executionHostId: `runtime:${environmentId}` as const,
      runtimeEnvironmentId: environmentId
    }

    // Each workspace keeps its own editor mounted; a runtime-owned model gets a host-keyed URI instead of file:.
    const localEditor = page.locator('.monaco-editor[data-uri^="file:"]').filter({ visible: true })
    const remoteEditor = page
      .locator('.monaco-editor[data-uri^="vscode-remote:"]')
      .filter({ visible: true })
    const localText = localEditor.locator('.view-lines')
    const remoteText = remoteEditor.locator('.view-lines')
    await openWorkspaceFile(page, local)
    await expect(localText).toHaveText('MARKER', { timeout: 30_000 })
    await localEditor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('!')
    await expect(localText).toHaveText('MARKER!')

    await openWorkspaceFile(page, remote)
    await expect(remoteText).toHaveText('MARKER', { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath('remote-before-undo.png') })
    await remoteEditor.click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(remoteText).toHaveText('MARKER')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('?')
    await expect(remoteText).toHaveText('MARKER?')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(remoteText).toHaveText('MARKER')

    await openWorkspaceFile(page, local)
    await expect(localText).toHaveText('MARKER!')
    await page.screenshot({ path: testInfo.outputPath('local-retained-edit.png') })
  } finally {
    await client?.dispose()
  }
})
