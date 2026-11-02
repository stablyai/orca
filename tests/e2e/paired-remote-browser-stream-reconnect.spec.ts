import type { Page } from '@stablyai/playwright-test'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  focusMaterializedRemoteBrowserPane,
  waitForMaterializedRemoteBrowserPane
} from './helpers/materialized-remote-browser-pane'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

// Drop the real runtime connection; require bounded failed stream retries followed by a persistent Reconnect control.

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

test('bounds remote browser stream retries, then offers reconnect', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser reconnect')
    const page = client.page

    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 60_000,
        message: 'paired client never saw a host worktree'
      })
      .toBeGreaterThan(0)
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('paired client did not receive the host worktree')
    }

    const created = await callEnvironment<{ browserPageId: string }>(
      page,
      client.environmentId,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: 'about:blank', activate: true }
    )
    // Use the mirrored tab; a second pane creates competing subscribers on a connection that keeps only the newest.
    await focusMaterializedRemoteBrowserPane(page, {
      environmentId: client.environmentId,
      remotePageId: created.browserPageId,
      worktreeId
    })

    const remoteFrame = page.getByTestId('remote-browser-frame').first()
    await expect(remoteFrame).toBeVisible({ timeout: 60_000 })

    const errorToast = page.getByTestId('remote-browser-stream-error')
    // Match Reconnect exactly so Browsing on Remote browser reconnect cannot satisfy the locator.
    const reconnectButton = page.getByRole('button', { name: 'Reconnect', exact: true })
    await expect(reconnectButton).toHaveCount(0)

    // Seed a pane-owned URL notice before drop; status change must replace it with the real connection failure.
    const remotePane = page
      .getByTestId('remote-browser-pane')
      .filter({ has: page.getByTestId('remote-browser-frame') })
    const addressBar = remotePane.locator('[data-orca-browser-address-bar="true"]')
    await addressBar.click()
    await addressBar.fill('about:config')
    await addressBar.press('Enter')
    await expect(errorToast).toContainText('Enter a valid http(s) or localhost URL.')

    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, client.environmentId)

    // Mid-budget: the pane is retrying, so it must NOT be offering reconnect yet.
    await expect(errorToast).toBeVisible({ timeout: 60_000 })
    // The pane must speak for itself here, not echo the transport's log string.
    await expect(errorToast).toContainText('Lost connection to the remote server.')
    await expect(errorToast).not.toContainText('Runtime environment')
    await expect(reconnectButton).toHaveCount(0)

    // Budget spans 500ms+1s+2s+4s+8s; once spent the control appears and retrying stops.
    await expect(reconnectButton).toBeVisible({ timeout: 90_000 })
    await page.screenshot({
      path: testInfo.outputPath('remote-browser-reconnect.png'),
      fullPage: false
    })
    await testInfo.attach('reconnect-ui', {
      path: testInfo.outputPath('remote-browser-reconnect.png'),
      contentType: 'image/png'
    })

    // It must stay put rather than quietly resuming a retry loop.
    await page.waitForTimeout(15_000)
    await expect(reconnectButton).toBeVisible()

    // Clicking the frozen frame must not clear the only recovery control or expose raw transport errors.
    await remoteFrame.click({ position: { x: 40, y: 40 }, force: true })
    await page.waitForTimeout(1_000)
    await expect(reconnectButton).toBeVisible()
    await expect(errorToast).not.toContainText('Runtime environment')

    await expect
      .poll(
        () =>
          page.evaluate(async (selector) => {
            const response = await window.api.runtimeEnvironments.connect({ selector })
            return response.ok
          }, client!.environmentId),
        { timeout: 60_000, message: 'paired client never reconnected to the host runtime' }
      )
      .toBe(true)

    // Require a new frame object URL; visibility alone also passes on the deliberately retained frozen image.
    const frozenFrameSrc = await remoteFrame.getAttribute('src')
    await reconnectButton.click()
    await expect(errorToast).toHaveCount(0, { timeout: 60_000 })
    await expect(remoteFrame).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(() => remoteFrame.getAttribute('src'), {
        timeout: 60_000,
        message: 'remote stream never delivered a new frame after reconnect'
      })
      .not.toBe(frozenFrameSrc)
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})

// Cover initial-open failure too, where no prior subscription exists to restart.
test('offers reconnect when the remote browser never opens at all', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser cold failure')
    const page = client.page

    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 60_000,
        message: 'paired client never saw a host worktree'
      })
      .toBeGreaterThan(0)
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('paired client did not receive the host worktree')
    }

    const created = await callEnvironment<{ browserPageId: string }>(
      page,
      client.environmentId,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: 'about:blank', activate: true }
    )

    // Let the mirrored row arrive without surfacing it so first pane mount happens after disconnect.
    const target = {
      environmentId: client.environmentId,
      remotePageId: created.browserPageId,
      worktreeId
    }
    await waitForMaterializedRemoteBrowserPane(page, target)

    // Drop before mount so the initial open has no existing stream to recover.
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, client.environmentId)
    await focusMaterializedRemoteBrowserPane(page, target)

    const errorToast = page.getByTestId('remote-browser-stream-error')
    // exact: true — see the first test: 'Reconnect' is a substring of the egress indicator's label.
    const reconnectButton = page.getByRole('button', { name: 'Reconnect', exact: true })
    await expect(errorToast).toBeVisible({ timeout: 90_000 })
    await expect(errorToast).toContainText('Cannot reach the remote server.')
    await expect(errorToast).not.toContainText('Runtime environment')
    await expect(reconnectButton).toBeVisible({ timeout: 90_000 })
    await page.screenshot({
      path: testInfo.outputPath('remote-browser-cold-failure.png'),
      fullPage: false
    })
    await testInfo.attach('reconnect-ui-cold-failure', {
      path: testInfo.outputPath('remote-browser-cold-failure.png'),
      contentType: 'image/png'
    })

    await expect
      .poll(
        () =>
          page.evaluate(async (selector) => {
            const response = await window.api.runtimeEnvironments.connect({ selector })
            return response.ok
          }, client!.environmentId),
        { timeout: 60_000, message: 'paired client never reconnected to the host runtime' }
      )
      .toBe(true)

    await reconnectButton.click()
    await expect(errorToast).toHaveCount(0, { timeout: 60_000 })
    await expect(page.getByTestId('remote-browser-frame').first()).toBeVisible({
      timeout: 60_000
    })
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
