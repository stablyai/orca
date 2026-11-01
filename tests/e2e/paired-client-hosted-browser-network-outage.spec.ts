import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  findMirroredBrowserPage,
  focusClientBrowserRow,
  navigateGuest,
  readClientBrowserRows,
  openClientHostedFixturePage,
  readClientWebviewMarker,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './helpers/client-hosted-browser-fixture'
import { startFreezableTcpProxy, type FreezableTcpProxy } from './helpers/freezable-tcp-proxy'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'

// Outlast the 15s lease grace; silent outages first need three missed 15s heartbeats to reap the socket.
const OUTAGE_MS = { reset: 25_000, silent: 100_000 } as const

async function readPageHostGeneration(
  client: PairedElectronClient,
  localPageId: string
): Promise<number | null> {
  return client.page.evaluate((pageId) => {
    const placement = window.__store?.getState().remoteBrowserPageHandlesByPageId[pageId]?.placement
    return placement?.kind === 'client' ? placement.pageHostGeneration : null
  }, localPageId)
}

/** Leaves the browser tab for the terminal and comes back, so the pane remounts its guest. */
async function remountBrowserTab(
  page: Page,
  worktreeId: string,
  localPageId: string
): Promise<number> {
  await page.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const terminal = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal'
    )
    if (terminal) {
      state.activateTab(terminal.id)
    }
  }, worktreeId)
  await page.waitForTimeout(1_000)
  await focusClientBrowserRow(page, worktreeId, localPageId)
  await page.waitForTimeout(3_000)
  return page.getByText('Client-hosted browser unavailable').count()
}

// Without restarting either app, recover the same desktop’s page after network loss voids its lease.
for (const mode of ['silent', 'reset'] as const) {
  test(`the same desktop re-hosts its browser tab after a ${mode} network outage longer than the lease grace`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(420_000)
    const fixture = await startClientHostedMarkerFixture({ created: 'outage-survivor', moved: 'x' })
    const host = await launchHeadlessPairedRuntimeHost()
    let client: PairedElectronClient | null = null
    let proxy: FreezableTcpProxy | null = null
    try {
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      const decoded = decodePairingOffer(host.offer.pairingUrl)
      if (!('endpoint' in decoded)) {
        throw new Error('expected a direct pairing offer')
      }
      const endpoint = new URL(decoded.endpoint)
      proxy = await startFreezableTcpProxy(endpoint.hostname, Number(endpoint.port))
      endpoint.port = String(proxy.port)
      client = await launchPairedElectronClient(
        { pairingUrl: encodePairingOffer({ ...decoded, endpoint: endpoint.toString() }) },
        testInfo,
        `client-hosted ${mode} outage`
      )
      const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
      await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
      const opened = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
      expect(
        await waitForRenderedClientWebview(
          client.page,
          { urlPrefix: fixture.markerUrl, remotePageId: opened.remotePageId },
          'client-hosted guest never rendered the fixture'
        )
      ).toBe('outage-survivor')
      const hostPid = host.app.process().pid
      const generationBefore = await readPageHostGeneration(client, opened.localPageId)
      expect(generationBefore).not.toBeNull()

      proxy.cut(mode)
      await new Promise((resolve) => setTimeout(resolve, OUTAGE_MS[mode]))
      proxy.restore()

      // Require a fresh placement generation so a stale guest read cannot masquerade as re-hosting.
      try {
        await expect
          .poll(() => readPageHostGeneration(client!, opened.localPageId), {
            timeout: 90_000,
            message: 'the same desktop never hosted its page again after the network returned'
          })
          .not.toBe(generationBefore)
      } catch (error) {
        const evidence = {
          generationBefore,
          generationAfter: await readPageHostGeneration(client, opened.localPageId),
          unavailableNotices: await client.page
            .getByText('Client-hosted browser unavailable')
            .count(),
          liveGuestMarker: await readClientWebviewMarker(client.page, {
            urlPrefix: fixture.markerUrl,
            remotePageId: opened.remotePageId
          }),
          noticesAfterRemount: await remountBrowserTab(client.page, worktreeId, opened.localPageId),
          clientRowsAfter: await readClientBrowserRows(client.page, worktreeId),
          markerAfterNavigating: await navigateGuest(
            client.page,
            fixture.markerUrl,
            fixture.movedUrl
          )
            .then(() => client!.page.waitForTimeout(10_000))
            .then(() =>
              readClientWebviewMarker(client!.page, {
                urlPrefix: fixture.origin,
                remotePageId: opened.remotePageId
              })
            )
            .catch((navigationError: unknown) => `navigation failed: ${String(navigationError)}`),
          proxyEvents: proxy.events
        }
        console.log('[outage] evidence', JSON.stringify(evidence))
        testInfo.annotations.push({
          type: 'outage-evidence',
          description: JSON.stringify(evidence)
        })
        await client.page.screenshot({ path: testInfo.outputPath('after-outage.png') })
        throw error
      }
      expect(
        await waitForRenderedClientWebview(
          client.page,
          { urlPrefix: fixture.markerUrl, remotePageId: opened.remotePageId },
          'the re-hosted page never rendered'
        )
      ).toBe('outage-survivor')
      await expect(client.page.getByText('Client-hosted browser unavailable')).toHaveCount(0)
      expect(
        (await findMirroredBrowserPage(client.page, worktreeId, fixture.markerUrl))?.placementKind
      ).toBe('client')
      // The re-hosted guest must be a working page, not just a rendered one.
      await navigateGuest(client.page, fixture.markerUrl, fixture.movedUrl)
      expect(
        await waitForRenderedClientWebview(
          client.page,
          { urlPrefix: fixture.movedUrl, remotePageId: opened.remotePageId },
          'the re-hosted page never navigated'
        )
      ).toBe('x')
      expect(host.app.process().pid, 'the host must not have restarted').toBe(hostPid)
    } finally {
      if (client) {
        await cleanupE2EDaemons(client.userDataDir).catch(() => undefined)
        await client.dispose()
      }
      await proxy?.close()
      await host.dispose()
      await fixture.close()
    }
  })
}
