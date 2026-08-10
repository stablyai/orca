import type { Page } from '@stablyai/playwright-test'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

// What this proves: a paired client whose remote browser stream drops retries on a bounded budget,
// then surfaces a Reconnect control instead of either giving up silently or retrying forever. The
// failure is real, not injected — the runtime connection is dropped, so every restart genuinely
// fails while it is down.

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

/** Mirrors what the client does when the user opens a browser tab on a paired host. */
async function attachRemoteBrowserPane(
  page: Page,
  environmentId: string,
  worktreeId: string,
  remotePageId: string
): Promise<void> {
  await page.evaluate(
    ({ environmentId, worktreeId, remotePageId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('client store unavailable')
      }
      const browserTab = state.createBrowserTab(worktreeId, 'about:blank', {
        title: 'New Browser Tab',
        browserRuntimeEnvironmentId: environmentId
      })
      const pageId = browserTab.activePageId ?? browserTab.pageIds?.[0] ?? null
      if (!pageId) {
        throw new Error('client did not allocate a browser page id')
      }
      state.setRemoteBrowserPageHandle(pageId, { environmentId, remotePageId })
      state.setActiveWorktree(worktreeId)
      state.focusBrowserTabInWorktree(worktreeId, browserTab.id, { surfacePane: true })
    },
    { environmentId, worktreeId, remotePageId }
  )
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
    await attachRemoteBrowserPane(page, client.environmentId, worktreeId, created.browserPageId)

    // The stream is live once the pane paints a remote frame.
    const remoteFrame = page.getByTestId('remote-browser-frame').first()
    await expect(remoteFrame).toBeVisible({ timeout: 60_000 })

    const errorToast = page.getByTestId('remote-browser-stream-error')
    const reconnectButton = page.getByRole('button', { name: 'Reconnect' })
    await expect(reconnectButton).toHaveCount(0)

    // Leave a pane-owned notice on screen before the drop. It outranks the stream's own message by
    // design (it is the only response to what the user typed), so if nothing clears it on a status
    // change, the stranded pane below reports a stale URL complaint next to its Reconnect button and
    // never says what actually happened. The 'Lost connection' assertion after the drop is what
    // catches that.
    // Scoped to the pane holding the remote frame: a workspace can hold more than one browser pane.
    const remotePane = page
      .getByTestId('remote-browser-pane')
      .filter({ has: page.getByTestId('remote-browser-frame') })
    const addressBar = remotePane.locator('[data-orca-browser-address-bar="true"]')
    await addressBar.click()
    await addressBar.fill('about:config')
    await addressBar.press('Enter')
    await expect(errorToast).toContainText('Enter a valid http(s) or localhost URL.')

    // Drop the runtime connection: the stream closes and every restart attempt now genuinely fails.
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

    // Clicking the frozen frame is the natural reaction to a stuck pane, and the input handlers
    // clear the error optimistically — so without a guard this exact gesture deletes the user's only
    // way back, then repaints the raw transport string once the queued RPC fails.
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

    // Why the frame src and not just visibility: the pane deliberately keeps the last frame painted
    // during a restart, so "an image is showing" is also true of a frozen, dead stream. A changed
    // object URL means a NEW frame actually arrived, which only a live subscription can produce.
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

// The other door into the same failure: the pane never had a stream to lose. A drop-only fix leaves
// this one stranded on a bare error, which is the original bug wearing a different hat.
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

    // Drop the connection BEFORE the pane mounts, so the very first open fails and no stream ever
    // exists. Nothing here can be recovered by restarting a subscription.
    await page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, client.environmentId)
    await attachRemoteBrowserPane(page, client.environmentId, worktreeId, created.browserPageId)

    const errorToast = page.getByTestId('remote-browser-stream-error')
    const reconnectButton = page.getByRole('button', { name: 'Reconnect' })
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

    // Reconnect must build the stream from nothing, not resume something that never existed.
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
