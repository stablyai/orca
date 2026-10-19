import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'
import { writeFile } from 'node:fs/promises'

test('browser automation highlights its exact page and clears after success and failure', async ({
  orcaPage
}, testInfo) => {
  await waitForActiveWorktree(orcaPage)
  const activeWorktreeId = await getActiveWorktreeId(orcaPage)
  if (!activeWorktreeId) {
    throw new Error('No active workspace')
  }
  const worktreeId = activeWorktreeId

  async function createPage(): Promise<string> {
    const response: unknown = await orcaPage.evaluate(
      (worktree) =>
        window.api.runtime.call({
          method: 'browser.tabCreate',
          params: { worktree, url: 'about:blank' }
        }),
      worktreeId
    )
    if (
      !response ||
      typeof response !== 'object' ||
      !('ok' in response) ||
      !response.ok ||
      !('result' in response) ||
      !response.result ||
      typeof response.result !== 'object' ||
      !('browserPageId' in response.result) ||
      typeof response.result.browserPageId !== 'string'
    ) {
      throw new Error(`Browser creation failed: ${JSON.stringify(response)}`)
    }
    return response.result.browserPageId
  }

  async function showPage(pageId: string): Promise<void> {
    await orcaPage.evaluate(
      ({ worktree, browserPageId }) => {
        window.__store?.getState().focusBrowserTabInWorktree(worktree, browserPageId)
      },
      { worktree: worktreeId, browserPageId: pageId }
    )
  }

  async function screenshot(name: string): Promise<void> {
    if (process.env.ORCA_BROWSER_ACTIVITY_SCREENSHOTS !== '1') {
      return
    }
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    await writeFile(testInfo.outputPath(name), Buffer.from(data, 'base64'))
    await cdp.detach()
  }

  const pageA = await createPage()
  const pageB = await createPage()
  await showPage(pageA)
  await expect(orcaPage.locator('[data-browser-automation-page-id]')).toHaveCount(0)
  await screenshot('browser-idle.png')

  const running = orcaPage.evaluate(
    (browserPageId) =>
      window.api.runtime.call({
        method: 'browser.eval',
        params: {
          page: browserPageId,
          expression: 'new Promise(resolve => setTimeout(() => resolve("done"), 12000))'
        }
      }),
    pageB
  )
  await expect(orcaPage.locator(`[data-browser-automation-page-id="${pageA}"]`)).toHaveCount(0)
  await showPage(pageB)
  await expect(orcaPage.locator(`[data-browser-automation-page-id="${pageB}"]`)).toBeVisible()
  await expect(
    orcaPage.getByRole('status').filter({ hasText: 'Browser automation active' })
  ).toBeVisible()
  await screenshot('browser-active.png')
  await orcaPage.evaluate(() => window.__store?.getState().updateSettings({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  await expect(
    orcaPage.locator(
      `[data-browser-automation-page-id="${pageB}"] .rounded-full[aria-hidden="true"]`
    )
  ).toHaveCSS('animation-name', 'none')
  await screenshot('browser-active-reduced-motion.png')
  const result = await running
  expect(result).toMatchObject({ ok: true })
  await expect(orcaPage.locator('[data-browser-automation-page-id]')).toHaveCount(0)

  const failing = orcaPage.evaluate(
    (browserPageId) =>
      window.api.runtime.call({
        method: 'browser.eval',
        params: {
          page: browserPageId,
          expression:
            'new Promise((_, reject) => setTimeout(() => reject(new Error("intentional activity failure")), 3000))'
        }
      }),
    pageB
  )
  await expect(orcaPage.locator(`[data-browser-automation-page-id="${pageB}"]`)).toBeVisible()
  expect(await failing).toMatchObject({ ok: false })
  await expect(orcaPage.locator('[data-browser-automation-page-id]')).toHaveCount(0)
})
