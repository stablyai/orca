import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { readHostBrowserPageIds, readHostBrowserPageUrl } from './helpers/host-session-tabs'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  findMirroredBrowserPage,
  focusClientBrowserRow,
  navigateGuest,
  openClientHostedFixturePage,
  readClientBrowserRows,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './helpers/client-hosted-browser-fixture'
import {
  refreshAuthorityRuntimeId,
  waitForRelaunchedRuntime
} from './helpers/client-hosted-runtime-relaunch'

const CLIENT_NAME = 'STA-4150 client-hosted restart survival'

// Replace the real serve process while its desktop client retains the guest; quit-survival.spec.ts covers the inverse.
// Authority mismatch must wait for the successor; rebuild host inventory, adopt a fresh generation exactly once, and retain the moved URL.
test('keeps a client-hosted browser tab across a paired runtime restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(420_000)
  const fixture = await startClientHostedMarkerFixture({
    created: 'restart-survivor',
    moved: 'moved-on'
  })
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME)
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)

    const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.markerUrl, remotePageId: opened.remotePageId },
        'client-hosted guest never rendered the fixture'
      )
    ).toBe('restart-survivor')

    // Require a host-held page before restart to prevent an empty recovery pass.
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must hold the client-hosted page before the restart'
    ).toContain(opened.remotePageId)

    // Move off the create URL so recovery cannot pass by replaying it.
    await navigateGuest(client.page, fixture.markerUrl, fixture.movedUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.movedUrl, remotePageId: opened.remotePageId },
        'the guest never rendered the page it navigated to'
      )
    ).toBe('moved-on')
    await expect
      .poll(() => readHostBrowserPageUrl(host.client, testRepoPath, opened.remotePageId), {
        timeout: 60_000,
        message: 'the runtime never learned where the guest navigated'
      })
      .toBe(fixture.movedUrl)

    const runtimeIdBeforeRestart = await refreshAuthorityRuntimeId(client)
    expect(runtimeIdBeforeRestart, 'client must know the runtime it is paired with').not.toBeNull()
    const hostPidBeforeRestart = host.app.process().pid

    await host.restartServeProcess()
    expect(host.app.process().pid, 'the serve process must actually be replaced').not.toBe(
      hostPidBeforeRestart
    )
    await waitForRelaunchedRuntime(client, runtimeIdBeforeRestart!)
    // The relaunched serve process starts from its user-data dir, so the repo is re-announced.
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' }).catch(() => undefined)
    const restartedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, restartedWorktreeId)

    await expect
      .poll(() => readHostBrowserPageIds(host.client, testRepoPath), {
        timeout: 180_000,
        message: 'the relaunched runtime never took the client-hosted page back'
      })
      .toContain(opened.remotePageId)

    let survivor: Awaited<ReturnType<typeof findMirroredBrowserPage>> = null
    // Reconnection can replace the retained row between reads; wait for the whole contract.
    await expect(async () => {
      const rows = await readClientBrowserRows(client!.page, restartedWorktreeId)
      const survivorRows = rows.filter((row) => row.url.startsWith(fixture.origin))
      expect(survivorRows, 'the tab must survive the restart exactly once').toHaveLength(1)

      survivor = await findMirroredBrowserPage(client!.page, restartedWorktreeId, fixture.origin)
      expect(
        survivor?.remotePageId,
        'recovery must keep the page identity it was created with'
      ).toBe(opened.remotePageId)
      expect(survivor?.placementKind, 'the surviving tab must still be client-hosted').toBe(
        'client'
      )
    }).toPass({ timeout: 180_000 })

    await focusClientBrowserRow(client.page, restartedWorktreeId, survivor!.localPageId)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.movedUrl, remotePageId: survivor!.remotePageId },
        'the surviving tab never rendered its guest again'
      ),
      'the tab must come back where the user left it, not on its create URL'
    ).toBe('moved-on')
    const renderedRows = await readClientBrowserRows(client.page, restartedWorktreeId)
    expect(
      renderedRows.filter((row) => row.url.startsWith(fixture.origin)),
      'rendering the recovered guest must leave exactly one surviving tab'
    ).toHaveLength(1)
  } finally {
    if (client) {
      await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
      await client.dispose()
    }
    await host.dispose()
    await fixture.close()
  }
})
