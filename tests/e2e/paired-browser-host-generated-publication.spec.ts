import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type FaultSnapshot = {
  armed: boolean
  createdPageId: string | null
  provisionalPageId: string | null
  requestedKnownPageId: boolean | null
  releasedPageSnapshotSuppressed: boolean
  suppressedPageIds: string[]
}

type FaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: {
    arm: () => void
    releaseWithPublicationLag: () => boolean
    reset: () => void
    snapshot: () => FaultSnapshot
  }
}

async function readHostBrowserPageIds(
  hostClient: RuntimeClient,
  worktreeId: string
): Promise<string[]> {
  const response = await hostClient.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  return response.result.tabs.flatMap((tab) =>
    tab.type === 'browser' && tab.browserPageId ? [tab.browserPageId] : []
  )
}

async function readClientRemotePageIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    return (state?.browserTabsByWorktree[targetWorktreeId] ?? []).flatMap((workspace) =>
      (state?.browserPagesByWorkspace[workspace.id] ?? []).flatMap((browserPage) => {
        const remotePageId = state?.remoteBrowserPageHandlesByPageId[browserPage.id]?.remotePageId
        return remotePageId ? [remotePageId] : []
      })
    )
  }, worktreeId)
}

async function findPairedWorktreeId(page: Page, repoPath: string): Promise<string> {
  const worktreeId = await expect
    .poll(
      () =>
        page.evaluate(
          (path) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .find((worktree) => worktree.path === path)?.id ?? null,
          repoPath
        ),
      { timeout: 60_000, message: 'paired client never received the host worktree' }
    )
    .not.toBeNull()
    .then(() =>
      page.evaluate(
        (path) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.path === path)?.id ?? null,
        repoPath
      )
    )
  if (!worktreeId) {
    throw new Error('Paired client worktree disappeared after discovery')
  }
  return worktreeId
}

async function armHostGeneratedPublicationLag(
  client: PairedElectronClient,
  worktreeId: string
): Promise<void> {
  await client.page.evaluate(
    ({ environmentId, knownIdCapability, worktreeId }) => {
      const store = window.__store
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!store || !fault) {
        throw new Error('Paired browser publication fault seam unavailable')
      }
      const state = store.getState()
      const current = state.runtimeStatusByEnvironmentId.get(environmentId)
      if (!current?.status) {
        throw new Error('Paired runtime status unavailable')
      }
      store.setState({
        runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
          environmentId,
          {
            ...current,
            status: {
              ...current.status,
              capabilities: current.status.capabilities?.filter(
                (capability) => capability !== knownIdCapability
              )
            }
          }
        )
      })
      state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      fault.arm()
    },
    {
      environmentId: client.environmentId,
      knownIdCapability: BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
      worktreeId
    }
  )
}

test('materializes a host-generated browser id after stale publication @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo: TestInfo) => {
  test.setTimeout(300_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const hostClient = new RuntimeClient(userDataDir, 5_000)
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'host-generated browser publication')
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    const worktreeId = await findPairedWorktreeId(client.page, testRepoPath)
    const baselineHostPageIds = await readHostBrowserPageIds(hostClient, worktreeId)
    await armHostGeneratedPublicationLag(client, worktreeId)

    await client.page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    await client.page.getByRole('menuitem', { name: /New Browser Tab/ }).click()
    await expect
      .poll(
        () =>
          client!.page.evaluate(() => {
            const snapshot = (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot()
            return Boolean(
              snapshot?.createdPageId && snapshot.suppressedPageIds.includes(snapshot.createdPageId)
            )
          }),
        { timeout: 30_000, message: 'browser create never reached the publication barrier' }
      )
      .toBe(true)
    const held = await client.page.evaluate(
      () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
    )
    const createdPageId = held?.createdPageId
    if (!createdPageId) {
      throw new Error('Host-generated browser page id was not captured')
    }
    expect(createdPageId).not.toBe(held?.provisionalPageId)
    expect(held?.requestedKnownPageId).toBe(false)
    expect(held.suppressedPageIds).toContain(createdPageId)
    expect(await readClientRemotePageIds(client.page, worktreeId)).not.toContain(createdPageId)
    expect(await readHostBrowserPageIds(hostClient, worktreeId)).toContain(createdPageId)

    expect(
      await client.page.evaluate(
        () =>
          (window as FaultWindow).__webRuntimeBrowserCreationFault?.releaseWithPublicationLag() ??
          false
      )
    ).toBe(true)
    await expect
      .poll(() => readClientRemotePageIds(client!.page, worktreeId), {
        timeout: 30_000,
        message: 'client did not materialize the host-generated page after retry'
      })
      .toContain(createdPageId)
    expect(
      await client.page.evaluate(
        () =>
          (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot()
            .releasedPageSnapshotSuppressed ?? false
      )
    ).toBe(true)
    expect(await readHostBrowserPageIds(hostClient, worktreeId)).toEqual([
      ...baselineHostPageIds,
      createdPageId
    ])
    await expect(
      client.page.getByText('The paired runtime could not create a managed browser tab.')
    ).toHaveCount(0)
    await client.page.screenshot({
      path: testInfo.outputPath('host-generated-browser-publication-green.png'),
      fullPage: true
    })

    await hostClient.call('browser.tabClose', {
      page: createdPageId,
      worktree: `id:${worktreeId}`
    })
    await client.page.evaluate(() =>
      (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset()
    )
  } finally {
    await client?.dispose()
  }
})
