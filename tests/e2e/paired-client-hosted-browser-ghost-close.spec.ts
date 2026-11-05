import { readdirSync, existsSync } from 'node:fs'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { readHostBrowserPageIds } from './helpers/host-session-tabs'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  findMirroredBrowserPage,
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

const CLIENT_NAME = 'STA-4150 client-hosted ghost close'

/** Longer than the runtime's 15s reconnect grace, so the runtime treats the host as gone for good. */
const RECONNECT_GRACE_OVERSHOOT_MS = 20_000

// Remove persisted host records to model older servers or unrecoverable page retirement, leaving a client-only row.
function forgetPersistedClientHostedPages(userDataDir: string): number {
  const profilesDir = path.join(userDataDir, 'profiles')
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(profilesDir, entry.name, 'profile-state.db'))
    )
    .reduce(
      (total, entry) =>
        total +
        mutateStoppedProfileState(
          userDataDir,
          (raw) => {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test owns the persisted fixture; optional fields are checked at use sites.
            const state = raw as {
              workspaceSession?: { clientHostedBrowserPagesByWorktree?: Record<string, unknown[]> }
              workspaceSessionsByHostId?: Record<
                string,
                { clientHostedBrowserPagesByWorktree?: Record<string, unknown[]> }
              >
            }
            let forgotten = 0
            for (const session of [
              state.workspaceSession,
              ...Object.values(state.workspaceSessionsByHostId ?? {})
            ]) {
              const rows = session?.clientHostedBrowserPagesByWorktree
              if (!rows) {
                continue
              }
              forgotten += Object.values(rows).reduce((count, list) => count + list.length, 0)
              delete session.clientHostedBrowserPagesByWorktree
            }
            return forgotten
          },
          entry.name
        ),
      0
    )
}

// Require the restored ghost row’s real X to dismiss it after session.tabs.close returns tab_not_found.
// This pins client fallback; server-side browser ghost retirement is independently covered by orca-runtime-browser-ghost-session-row-close.test.ts.
test('closes a restored client-hosted row whose runtime has no record of it', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(600_000)
  const fixture = await startClientHostedMarkerFixture({ created: 'ghost', moved: 'moved-on' })
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
    ).toBe('ghost')
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the runtime must hold the page before it is made to forget it'
    ).toContain(opened.remotePageId)

    const runtimeIdBeforeRestart = await refreshAuthorityRuntimeId(client)
    expect(runtimeIdBeforeRestart, 'client must know the runtime it is paired with').not.toBeNull()

    const quitting = client.app
    client = null
    abandonedProfile = profileDir
    await closeElectronAppForE2E(quitting)
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_GRACE_OVERSHOOT_MS))

    // Edit between processes or serve’s quit-time flush overwrites the fixture change.
    let forgotten = 0
    await host.restartServeProcess({
      betweenProcesses: () => {
        forgotten = forgetPersistedClientHostedPages(host.userDataDir)
      }
    })
    // Require records before stripping them so an empty fixture cannot pass.
    expect(
      forgotten,
      'the runtime must have persisted the page before this test can take it away'
    ).toBeGreaterThan(0)
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' }).catch(() => undefined)
    expect(
      await readHostBrowserPageIds(host.client, testRepoPath),
      'the relaunched runtime must genuinely have no record of the page'
    ).not.toContain(opened.remotePageId)

    client = await launchPairedElectronClient(host.offer, testInfo, CLIENT_NAME, {
      reuseUserDataDir: profileDir
    })
    abandonedProfile = null
    await waitForRelaunchedRuntime(client, runtimeIdBeforeRestart!)
    const relaunchedWorktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, relaunchedWorktreeId)

    // The ghost: the client restored the row from its own session, and nothing will ever answer it.
    await expect
      .poll(() => findMirroredBrowserPage(client!.page, relaunchedWorktreeId, fixture.origin), {
        timeout: 120_000,
        message: 'the relaunched client never restored the row its own session persisted'
      })
      .not.toBeNull()
    const ghost = await findMirroredBrowserPage(client.page, relaunchedWorktreeId, fixture.origin)
    expect(ghost?.visibleTabId, 'the restored row must have a visible tab to close').not.toBeNull()

    // Click the row’s real X; a store close would bypass the broken user close policy.
    const ghostTab = client.page.locator(`[data-tab-id="${ghost!.workspaceId}"]`)
    await expect(ghostTab).toBeVisible({ timeout: 60_000 })
    await ghostTab.locator('> button').click()

    await expect
      .poll(
        async () =>
          (await readClientBrowserRows(client!.page, relaunchedWorktreeId)).filter((row) =>
            row.url.startsWith(fixture.origin)
          ).length,
        {
          timeout: 120_000,
          message: 'the X on a row no runtime answers for never removed it'
        }
      )
      .toBe(0)
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
