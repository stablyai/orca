import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

// #36804: a click on a target=_blank link in a streamed server page opens a new Orca tab.

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

async function startLinkServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url === '/destination') {
      response.end('<!doctype html><title>Blank destination</title><h1>Destination</h1>')
      return
    }
    // The link fills the viewport so a click anywhere on the streamed frame lands on it.
    response.end(`<!doctype html><title>Link source</title>
      <style>html,body{margin:0;height:100%}a{display:block;height:100%;font:40px system-ui}</style>
      <a id="blank-link" href="/destination" target="_blank">Open destination</a>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

test('a target=_blank click in a streamed server page opens a new Orca tab', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const { server, origin } = await startLinkServer()
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Remote browser blank link')
    const page = client.page
    const environmentId = client.environmentId

    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0), {
        timeout: 60_000
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
      environmentId,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: `${origin}/`, activate: true }
    )
    const sourceTab = await focusMaterializedRemoteBrowserPane(page, {
      environmentId,
      remotePageId: created.browserPageId,
      worktreeId
    })
    const remoteFrame = page.getByTestId('remote-browser-frame').first()
    await expect(remoteFrame).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            (id) =>
              Object.values(window.__store?.getState().browserTabsByWorktree[id] ?? {}).some(
                (tab) => tab.title === 'Link source'
              ),
            worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)

    type TabList = { tabs: { browserPageId: string; url: string }[] }
    const listPages = async (): Promise<string[]> =>
      (
        await callEnvironment<TabList>(page, environmentId, 'browser.tabList', {
          worktree: `id:${worktreeId}`
        })
      ).tabs.map((tab) => tab.browserPageId)
    const waitForOpenedPage = async (before: string[]): Promise<string> => {
      await expect
        .poll(async () => (await listPages()).length, {
          timeout: 30_000,
          message: 'the server never opened the link as a tab'
        })
        .toBe(before.length + 1)
      return (await listPages()).find((id) => !before.includes(id))!
    }
    const activeTabId = (): Promise<string | null> =>
      page.evaluate(
        (id) => window.__store?.getState().activeBrowserTabIdByWorktree[id] ?? null,
        worktreeId
      )

    // A scripted click names no client, so the tab opens without moving anyone's view.
    let before = await listPages()
    await callEnvironment(page, environmentId, 'browser.eval', {
      worktree: `id:${worktreeId}`,
      page: created.browserPageId,
      expression: "document.getElementById('blank-link').click()"
    })
    await waitForMaterializedRemoteBrowserPane(page, {
      environmentId,
      remotePageId: await waitForOpenedPage(before),
      worktreeId
    })
    expect(await activeTabId()).toBe(sourceTab.tabId)

    // The client that clicks gets the new tab in front, as a local page would.
    before = await listPages()
    await remoteFrame.click()
    const clicked = await waitForMaterializedRemoteBrowserPane(page, {
      environmentId,
      remotePageId: await waitForOpenedPage(before),
      worktreeId
    })
    await expect.poll(activeTabId).toBe(clicked.tabId)
    await page.screenshot({ path: testInfo.outputPath('blank-link-opened.png') })
  } finally {
    await client?.dispose()
    await host.dispose()
    server.close()
  }
})
