import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { readHostBrowserPageIds, readHostBrowserPageUrl } from './helpers/host-session-tabs'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
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

const CLIENT_NAME = 'STA-4150 client-hosted double restart'

/** Longer than the runtime's 15s reconnect grace, so the runtime treats the host as gone for good. */
const RECONNECT_GRACE_OVERSHOOT_MS = 20_000

/**
 * Both authorities restart at once — the field case a fleet auto-update produces.
 *
 * The single-restart specs each leave one side holding the evidence: a client quit leaves the
 * runtime holding the page record, and a runtime restart leaves the client holding the live guest
 * its inventory can be rebuilt from. Restart both and neither is left, which is why this scenario
 * needs the runtime's records to be durable rather than reconstructible.
 *
 * The order here is strictly harder than simultaneous: the client is already gone when the runtime
 * comes back, so the runtime has to publish the page from disk with nothing attached at all, and
 * the returning client has to be re-authenticated into a page it can no longer prove it owned.
 */
test('keeps a client-hosted browser tab when the client and the runtime both restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(600_000)
  const fixture = await startClientHostedMarkerFixture({
    created: 'double-restart-survivor',
    moved: 'moved-on'
  })
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  let abandonedProfile: string | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME)
    const profileDir = client.userDataDir
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)

    const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.markerUrl, remotePageId: opened.remotePageId },
        'client-hosted guest never rendered the fixture'
      )
    ).toBe('double-restart-survivor')

    // Presence precondition: without it every later check could pass on a page that was never held.
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must hold the client-hosted page before either restart'
    ).toContain(opened.remotePageId)

    // Why the guest moves first: on its create URL, restoring correctly and replaying the URL the
    // tab was born on are the same answer.
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

    // Quit without disposing: the profile has to outlive the app, as it does for a real Cmd+Q.
    const quitting = client.app
    client = null
    abandonedProfile = profileDir
    await closeElectronAppForE2E(quitting)
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_OVERSHOOT_MS))

    const hostPidBeforeRestart = host.app.process().pid
    await host.restartServeProcess()
    expect(host.app.process().pid, 'the serve process must actually be replaced').not.toBe(
      hostPidBeforeRestart
    )
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' }).catch(() => undefined)

    // The oracle for this round: with no client attached and no in-memory record left, the only
    // thing that can still name this page is what the previous runtime wrote to disk.
    await expect
      .poll(() => readHostBrowserPageIds(host.client, testRepoPath), {
        timeout: 60_000,
        message: 'the relaunched runtime did not restore the client-hosted page from persistence'
      })
      .toContain(opened.remotePageId)
    expect(
      await readHostBrowserPageUrl(host.client, testRepoPath, opened.remotePageId),
      'the restored record must remember where the guest was, not where it was created'
    ).toBe(fixture.movedUrl)

    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME, {
      reuseUserDataDir: profileDir
    })
    abandonedProfile = null
    await waitForRelaunchedRuntime(client, runtimeIdBeforeRestart!)
    const relaunchedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, relaunchedWorktreeId)

    await expect
      .poll(
        async () =>
          (await findMirroredBrowserPage(client!.page, relaunchedWorktreeId, fixture.movedUrl))
            ?.placementKind ?? null,
        {
          timeout: 180_000,
          message: 'the tab never became client-hosted again after both sides restarted'
        }
      )
      .toBe('client')

    // Counted across the whole origin: a recovery that also replays the create URL leaves two rows,
    // and matching only the moved one would call that a pass.
    const survivorRows = (await readClientBrowserRows(client.page, relaunchedWorktreeId)).filter(
      (row) => row.url.startsWith(fixture.origin)
    )
    expect(survivorRows, 'the tab must survive both restarts exactly once').toHaveLength(1)

    const survivor = await findMirroredBrowserPage(
      client.page,
      relaunchedWorktreeId,
      fixture.movedUrl
    )
    expect(survivor?.remotePageId, 'recovery must keep the page identity it was created with').toBe(
      opened.remotePageId
    )

    await focusClientBrowserRow(client.page, relaunchedWorktreeId, survivor!.localPageId)
    expect(
      await waitForRenderedClientWebview(
        client.page,
        { urlPrefix: fixture.movedUrl, remotePageId: survivor!.remotePageId },
        'the surviving tab never rendered a live guest again'
      ),
      'the tab has to come back functional and where the user left it'
    ).toBe('moved-on')
  } finally {
    if (client) {
      await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
      await client.dispose()
    }
    if (abandonedProfile) {
      await cleanupE2EDaemons(abandonedProfile).catch(() => undefined)
    }
    await host.dispose()
    await fixture.close()
  }
})
