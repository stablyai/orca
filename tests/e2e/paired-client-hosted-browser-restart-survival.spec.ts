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

/**
 * Server-restart half of the tab-persistence contract. The client-quit half is covered by
 * paired-client-hosted-browser-quit-survival.spec.ts.
 *
 * Two real Electron processes: a headless paired runtime whose serve process is genuinely replaced
 * mid-test, and a desktop client running the guest. Each link in the chain a restart has to survive
 * has its own oracle here, because any one of them failing looks like the same empty tab strip:
 *
 * 1. The client's lease reconnects naming a runtime id that no longer exists. The replacement
 *    answers `browser_client_host_authority_mismatch`, which the client must read as "wait for the
 *    successor" rather than as a reason to retire the environment and its live guests.
 * 2. The relaunched runtime holds no page records, so it has to rebuild them from the inventory the
 *    reattaching host reports — asserted against the runtime's own page registry, not the client's.
 * 3. Adoption reissues the page under fresh generations, so the single-row count catches a recovery
 *    that replays the create URL alongside the adopted page.
 * 4. The guest must come back where the user left it, which is why the fixture moves the page before
 *    the restart: on its create URL, restoring correctly and restoring wrongly agree.
 */
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

    // Presence precondition: without it, every post-restart check could pass on a page the
    // runtime never held in the first place.
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must hold the client-hosted page before the restart'
    ).toContain(opened.remotePageId)

    // Why the guest moves before the restart: with the tab still on its create URL, recovering to
    // the create URL and recovering to where the user was are the same answer.
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

    await expect
      .poll(() => findMirroredBrowserPage(client!.page, restartedWorktreeId, fixture.origin), {
        timeout: 180_000,
        message: 'the client lost its client-hosted row across the runtime restart'
      })
      .not.toBeNull()

    // Counted across the whole fixture origin: a recovery that also replays the create URL leaves
    // two rows, and matching only the moved one would call that a pass.
    const rows = await readClientBrowserRows(client.page, restartedWorktreeId)
    const survivorRows = rows.filter((row) => row.url.startsWith(fixture.origin))
    expect(survivorRows, 'the tab must survive the restart exactly once').toHaveLength(1)

    const survivor = await findMirroredBrowserPage(client.page, restartedWorktreeId, fixture.origin)
    expect(survivor?.remotePageId, 'recovery must keep the page identity it was created with').toBe(
      opened.remotePageId
    )
    expect(survivor?.placementKind, 'the surviving tab must still be client-hosted').toBe('client')

    await focusClientBrowserRow(client.page, restartedWorktreeId, survivor!.localPageId)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.movedUrl, remotePageId: survivor!.remotePageId },
        'the surviving tab never rendered its guest again'
      ),
      'the tab must come back where the user left it, not on its create URL'
    ).toBe('moved-on')
  } finally {
    if (client) {
      await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
      await client.dispose()
    }
    await host.dispose()
    await fixture.close()
  }
})
