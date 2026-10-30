// #33424: two desktops paired to each other. B's tab on a file in A's workspace must not reach A as B's
// own tab, or A routes that file's reads and closes to B, which lacks the workspace.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { createRuntimeDesktopPairingOffer } from './helpers/paired-electron-client'

async function pairAndSelect(page: Page, pairingUrl: string, name: string): Promise<string> {
  return page.evaluate(
    async ({ name, pairingUrl }) => {
      const store = window.__store!
      const result = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name,
        pairingCode: pairingUrl,
        allowLoopback: true
      })
      if (!result.ok) {
        throw new Error(`Pairing ${name} failed: ${JSON.stringify(result)}`)
      }
      const id = result.environment.id
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      if (!(await store.getState().refreshRuntimeEnvironmentStatus(id))) {
        throw new Error(`Could not reach ${name}`)
      }
      if (!(await store.getState().setActiveRuntimeEnvironmentPreference(id))) {
        throw new Error(`Could not select ${name}`)
      }
      return id
    },
    { name, pairingUrl }
  )
}

async function addLocalFolder(page: Page, folderPath: string): Promise<string> {
  const repoId = await page.evaluate(async (folderPath) => {
    const added = await window.api.repos.add({ path: folderPath, kind: 'folder' })
    if ('error' in added) {
      throw new Error(added.error)
    }
    return added.repo.id
  }, folderPath)
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        worktreeId = await page.evaluate(async (repoId) => {
          const store = window.__store!
          await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          await store.getState().fetchWorktrees(repoId)
          return (
            store
              .getState()
              .allWorktrees()
              .find((entry) => entry.repoId === repoId)?.id ?? ''
          )
        }, repoId)
        return worktreeId
      },
      { timeout: 30_000, message: 'Desktop B never listed its own folder' }
    )
    .not.toBe('')
  return worktreeId
}

function tabIdsIn(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store!.getState().unifiedTabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

function openFilesIn(page: Page, worktreeId: string) {
  return page.evaluate(
    (id) =>
      window
        .__store!.getState()
        .openFiles.filter((file) => file.worktreeId === id)
        .map((file) => ({
          relativePath: file.relativePath,
          env: file.runtimeEnvironmentId ?? null
        })),
    worktreeId
  )
}

test('a desktop gets no tab back for its own workspace from a server it serves', async ({
  orcaPage
}, testInfo) => {
  // Two desktops launch and pair to each other.
  test.setTimeout(240_000)
  const desktopBFolder = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-desktop-b-'))
  writeFileSync(path.join(desktopBFolder, 'note.md'), '# desktop B\n')
  const hubBSession = createRestartSession(testInfo)
  const hubB = await hubBSession.launch()
  try {
    await hubB.page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      { timeout: 60_000 }
    )
    const worktree = await orcaPage.evaluate(() => {
      const listed = window.__store!.getState().allWorktrees()[0]
      return listed ? { id: listed.id, path: listed.path } : null
    })
    expect(worktree).not.toBeNull()
    const { id: worktreeId, path: worktreePath } = worktree!
    const desktopBWorktreeId = await addLocalFolder(hubB.page, desktopBFolder)
    const desktopATabIds = await tabIdsIn(orcaPage, worktreeId)

    const desktopBOnA = await pairAndSelect(
      orcaPage,
      (await createRuntimeDesktopPairingOffer(hubB.page)).pairingUrl,
      'Desktop B'
    )
    const desktopAOnB = await pairAndSelect(
      hubB.page,
      (await createRuntimeDesktopPairingOffer(orcaPage)).pairingUrl,
      'Desktop A'
    )
    await expect
      .poll(
        () =>
          hubB.page.evaluate(
            (id) =>
              window
                .__store!.getState()
                .allWorktrees()
                .some((entry) => entry.id === id),
            worktreeId
          ),
        {
          timeout: 60_000,
          message: 'Desktop B never listed desktop A’s workspace'
        }
      )
      .toBe(true)

    await hubB.page.evaluate(
      ({ environmentId, worktreeId, worktreePath }) => {
        const state = window.__store!.getState()
        state.setActiveView('terminal')
        state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
        state.openFile({
          filePath: `${worktreePath}/README.md`,
          relativePath: 'README.md',
          worktreeId,
          runtimeEnvironmentId: environmentId,
          language: 'markdown',
          mode: 'edit'
        })
      },
      { environmentId: desktopAOnB, worktreeId, worktreePath }
    )
    await expect
      .poll(() => openFilesIn(hubB.page, worktreeId), { timeout: 30_000 })
      .toEqual([{ relativePath: 'README.md', env: desktopAOnB }])

    // B's runtime holds B's tab in A's workspace; locally it is listed, only other runtimes are spared it.
    const desktopBRuntime = new RuntimeClient(hubBSession.userDataDir, 30_000, null, null)
    await expect
      .poll(
        async () => {
          const listed = await desktopBRuntime.call<{
            snapshots: { worktree: string; tabs: { type: string }[] }[]
          }>('session.tabs.listAll')
          return listed.result.snapshots.some(
            (snapshot) =>
              snapshot.worktree === worktreeId &&
              snapshot.tabs.some((tab) => tab.type === 'markdown')
          )
        },
        { timeout: 30_000, message: 'Desktop B never published its tab in A’s workspace' }
      )
      .toBe(true)
    // A frame B publishes later reaches A after any echo on the same stream.
    await hubB.page.evaluate(
      ({ worktreeId, filePath }) => {
        window.__store!.getState().openFile({
          filePath,
          relativePath: 'note.md',
          worktreeId,
          language: 'markdown',
          mode: 'edit'
        })
      },
      { worktreeId: desktopBWorktreeId, filePath: path.join(desktopBFolder, 'note.md') }
    )
    await expect
      .poll(() => openFilesIn(orcaPage, desktopBWorktreeId), {
        timeout: 30_000,
        message: 'Desktop A never mirrored a tab in desktop B’s own workspace'
      })
      .toEqual([{ relativePath: 'note.md', env: desktopBOnA }])
    expect(await openFilesIn(orcaPage, worktreeId)).toEqual([])
    expect(await tabIdsIn(orcaPage, worktreeId)).toEqual(desktopATabIds)
    expect(await openFilesIn(hubB.page, worktreeId)).toEqual([
      { relativePath: 'README.md', env: desktopAOnB }
    ])
  } finally {
    await hubBSession.close(hubB.app)
    await hubBSession.dispose()
    rmSync(desktopBFolder, { recursive: true, force: true })
  }
})
