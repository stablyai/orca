import { createConnection, createServer, type Socket, type AddressInfo } from 'node:net'
import type { Page } from '@stablyai/playwright-test'
import { decodePairingOffer, encodePairingOffer } from '../../src/shared/pairing'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  launchPairedWebClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'

async function interruptibleHost(offer: RuntimeDesktopPairingOffer) {
  const pairing = decodePairingOffer(offer.pairingUrl)
  const endpoint = new URL(pairing.endpoint)
  const sockets = new Set<Socket>()
  let online = true
  const server = createServer((client) => {
    if (!online) {
      client.destroy()
      return
    }
    const host = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) })
    for (const socket of [client, host]) {
      sockets.add(socket)
      socket.on('error', () => {
        client.destroy()
        host.destroy()
      })
      socket.on('close', () => {
        sockets.delete(socket)
        client.destroy()
        host.destroy()
      })
    }
    client.pipe(host).pipe(client)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const pairingUrl = encodePairingOffer({ ...pairing, endpoint: `ws://127.0.0.1:${address.port}` })
  let webClientUrl: string | undefined
  if (offer.webClientUrl) {
    const url = new URL(offer.webClientUrl)
    url.search = ''
    url.hash = new URLSearchParams({ pairing: pairingUrl }).toString()
    webClientUrl = url.href
  }
  return {
    offer: { pairingUrl, webClientUrl },
    setOnline(value: boolean) {
      online = value
      if (!online) {
        sockets.forEach((socket) => socket.destroy())
      }
    },
    async close() {
      sockets.forEach((socket) => socket.destroy())
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function statusEvidence(page: Page, environmentId?: string) {
  return page.evaluate((id) => {
    const entries = window.__store?.getState().runtimeStatusByEnvironmentId
    const entry = id ? entries?.get(id) : entries?.values().next().value
    return entry?.snapshot
      ? {
          verification: entry.snapshot.verification,
          transport: entry.snapshot.transport,
          runtimeId: entry.status?.runtimeId,
          sequence: entry.snapshot.sequence
        }
      : null
  }, environmentId)
}

async function expectWorkspaceHostAppearance(
  page: Page,
  disconnected: boolean,
  hostLabel?: string
) {
  const cards = page.locator('[data-worktree-card-surface="true"]')
  const card = (
    hostLabel ? cards.filter({ has: page.getByText(hostLabel, { exact: true }) }) : cards
  ).first()
  await expect(card).toBeVisible()
  await expect(card).toHaveCSS('opacity', disconnected ? '0.6' : '1')
  const icon = card.locator(disconnected ? 'svg.lucide-server-off' : 'svg.lucide-server').first()
  await expect(icon).toBeVisible()
  await expect(
    card.locator(disconnected ? 'svg.lucide-server' : 'svg.lucide-server-off')
  ).toHaveCount(0)
  await expect(icon).toHaveClass(disconnected ? /text-destructive/ : /text-muted-foreground/)
  await icon.hover()
  await expect(
    page.getByRole('tooltip', { name: disconnected ? /disconnected/i : /Project on/ })
  ).toBeVisible()
  await page.mouse.move(900, 600)
}

for (const topology of ['desktop', 'headless'] as const) {
  test(`connection-owned status recovers with a ${topology} host and independent viewers`, async ({
    electronApp,
    orcaPage: page,
    testRepoPath
  }, testInfo) => {
    test.setTimeout(180_000)
    let headless: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
    let proxy: Awaited<ReturnType<typeof interruptibleHost>> | undefined
    let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
    let browser: Awaited<ReturnType<typeof launchPairedWebClient>> | undefined
    try {
      headless =
        topology === 'headless'
          ? await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
          : null
      const offer = headless?.offer ?? (await createRuntimeDesktopPairingOffer(page))
      await (headless
        ? headless.client.call('repo.add', { path: testRepoPath })
        : page.evaluate(async (path) => {
            await window.api.repos.add({ path })
            await window.__store?.getState().fetchRepos()
          }, testRepoPath))
      proxy = await interruptibleHost(offer)
      client = await launchPairedElectronClient(offer, testInfo, 'Direct host')
      proxy.setOnline(false)
      const offlineId = await client.page.evaluate(async (pairingCode) => {
        const { environment } = await window.api.runtimeEnvironments.addFromPairingCode({
          name: 'Recovering host',
          pairingCode
        })
        const store = window.__store!.getState()
        store.setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
        await store.refreshRuntimeEnvironmentStatus(environment.id, 1_000)
        return environment.id
      }, proxy.offer.pairingUrl)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId))
        .toMatchObject({ verification: 'unavailable' })
      expect(await statusEvidence(client!.page, client.environmentId)).toMatchObject({
        verification: 'verified'
      })
      proxy.setOnline(true)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId), { timeout: 30_000 })
        .toMatchObject({ verification: 'verified', transport: 'ready' })
      const initial = await statusEvidence(client!.page, offlineId)
      await expectWorkspaceHostAppearance(client.page, false, 'Recovering host')
      await expect(client.page.getByText('Recovering host', { exact: true }).first()).toBeVisible()
      await client.page.screenshot({ path: testInfo.outputPath(`${topology}-recovered.png`) })
      browser = await launchPairedWebClient(electronApp, proxy.offer)
      await expect
        .poll(() => statusEvidence(browser!.page), { timeout: 30_000 })
        .toMatchObject({ verification: 'verified', transport: 'ready' })
      await expectWorkspaceHostAppearance(browser.page, false)
      proxy.setOnline(false)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId))
        .toMatchObject({ transport: 'disconnected' })
      await expect
        .poll(() => statusEvidence(browser!.page), { timeout: 30_000 })
        .toMatchObject({ transport: 'disconnected' })
      expect(await statusEvidence(client!.page, client.environmentId)).toMatchObject({
        verification: 'verified',
        transport: 'ready'
      })
      await expectWorkspaceHostAppearance(client.page, false, 'Recovering host')
      await expectWorkspaceHostAppearance(client.page, false, 'Direct host')
      await expectWorkspaceHostAppearance(browser.page, false)
      await client.page.screenshot({
        path: testInfo.outputPath(`${topology}-sidebar-reconnecting.png`)
      })
      await browser.page.screenshot({
        path: testInfo.outputPath(`${topology}-browser-reconnecting.png`)
      })
      proxy.setOnline(true)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId), { timeout: 30_000 })
        .toMatchObject({ verification: 'verified', transport: 'ready' })
      await expect
        .poll(() => statusEvidence(browser!.page), { timeout: 30_000 })
        .toMatchObject({ verification: 'verified', transport: 'ready' })
      expect((await statusEvidence(client!.page, offlineId))!.sequence).toBeGreaterThan(
        initial!.sequence
      )
      await expectWorkspaceHostAppearance(client.page, false, 'Recovering host')
      await expectWorkspaceHostAppearance(browser.page, false)
      await browser.page.screenshot({
        path: testInfo.outputPath(`${topology}-browser-recovered.png`)
      })
      await client.page.evaluate(async (selector) => {
        await window.api.runtimeEnvironments.disconnect({ selector })
      }, offlineId)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId))
        .toMatchObject({ verification: 'blocked', transport: 'disconnected' })
      await expectWorkspaceHostAppearance(client.page, true, 'Recovering host')
      await expectWorkspaceHostAppearance(client.page, false, 'Direct host')
      await client.page.screenshot({
        path: testInfo.outputPath(`${topology}-sidebar-disconnected.png`)
      })
      await client.page.evaluate(async (selector) => {
        await window.api.runtimeEnvironments.connect({ selector })
      }, offlineId)
      await expect
        .poll(() => statusEvidence(client!.page, offlineId), { timeout: 30_000 })
        .toMatchObject({ verification: 'verified', transport: 'ready' })
      await expectWorkspaceHostAppearance(client.page, false, 'Recovering host')
      await expectWorkspaceHostAppearance(browser.page, false)
      await client.page.screenshot({
        path: testInfo.outputPath(`${topology}-sidebar-restored.png`)
      })
    } finally {
      await browser?.dispose()
      await client?.dispose()
      await proxy?.close()
      await headless?.dispose()
    }
  })
}
