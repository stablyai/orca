import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * Strips what the runtime persisted, leaving a host that has genuinely forgotten the page.
 *
 * This is what a client meets against a server that predates page persistence, and what it meets
 * when recovery released a record as unrecoverable. Both leave the same shape: a client row that
 * nothing on the host answers for.
 */
function forgetPersistedClientHostedPages(userDataDir: string): number {
  return listOrcaDataFiles(userDataDir).reduce(
    (total, dataFile) => total + forgetPersistedClientHostedPagesIn(dataFile),
    0
  )
}

/**
 * Every orca-data.json under a user-data dir.
 *
 * The live one is `profiles/<id>/orca-data.json`; the root file is only the harness's onboarding
 * seed, which the first boot migrates from. Reading the seed alone made the strip a no-op that
 * looked exactly like a runtime that had persisted nothing.
 */
function listOrcaDataFiles(userDataDir: string): string[] {
  const profilesDir = path.join(userDataDir, 'profiles')
  let profileFiles: string[] = []
  try {
    profileFiles = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(profilesDir, entry.name, 'orca-data.json'))
  } catch {
    // No profile directory yet; only the harness seed exists.
  }
  return [path.join(userDataDir, 'orca-data.json'), ...profileFiles].filter((file) => {
    try {
      readFileSync(file, 'utf8')
      return true
    } catch {
      return false
    }
  })
}

function forgetPersistedClientHostedPagesIn(dataFile: string): number {
  const state = JSON.parse(readFileSync(dataFile, 'utf8')) as {
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
    forgotten += Object.values(rows).reduce((total, list) => total + list.length, 0)
    delete session.clientHostedBrowserPagesByWorktree
  }
  writeFileSync(dataFile, `${JSON.stringify(state, null, 2)}\n`)
  return forgotten
}

/**
 * The X on a restored client-hosted row whose host has no record of it.
 *
 * The restored marker exempts such a row from the absent-from-snapshot cull, so nothing retires it
 * on its own; and the close plan hands a connected owner the teardown on the grounds that the owner
 * removes its own mirror through tab sync. An owner that has forgotten the page does neither, which
 * left the row standing with an inert X and no way to dismiss it.
 *
 * What this pins is the CLIENT-side fallback: the X exits through session.tabs.close, which throws
 * tab_not_found before browserTabClose is ever reached, so the runtime's own ghost retirement never
 * runs here. Do not simplify the client fallback on the strength of this spec -- the server-side
 * retirement is covered by orca-runtime-browser-ghost-session-row-close.test.ts, and neither
 * covers the other.
 */
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

    // Between processes, not before the restart: the quitting serve flushes its own state on the
    // way out, so an earlier edit would be written straight back over.
    let forgotten = 0
    await host.restartServeProcess({
      betweenProcesses: () => {
        forgotten = forgetPersistedClientHostedPages(host.userDataDir)
      }
    })
    // Presence precondition for the strip: an empty edit would leave a passing test that never set
    // up the case at all.
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

    // The product affordance, not a store action: the defect is that this X does nothing, and a
    // store call would route around the very close policy under test. The strip keys a browser row
    // by its workspace id, and the X is the row's only button.
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
