import type { Page } from '@stablyai/playwright-test'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import type { TerminalLayoutSnapshot } from '../../src/shared/terminal-tab-types'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { expect, test } from './helpers/orca-app'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

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

async function openClientTab(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ tabId, worktreeId }) =>
            (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some(
              (tab) => tab.id === tabId
            ),
          { tabId, worktreeId }
        ),
      { timeout: 60_000, message: `paired client never mirrored host tab ${tabId}` }
    )
    .toBe(true)
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(tabId)
      state?.setActiveTabType('terminal')
    },
    { tabId, worktreeId }
  )
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, tabId), {
      timeout: 60_000,
      message: `paired client pane for ${tabId} did not mount`
    })
    .toBe(true)
}

async function readHostLayout(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string,
  hostTabId: string
): Promise<TerminalLayoutSnapshot | null> {
  const snapshot = (
    await host.client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${worktreeId}`
    })
  ).result
  return (
    snapshot.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === hostTabId)
      ?.parentLayout ?? null
  )
}

async function readClientLayout(page: Page, tabId: string): Promise<TerminalLayoutSnapshot | null> {
  return page.evaluate((id) => window.__store?.getState().terminalLayoutsByTabId[id] ?? null, tabId)
}

async function setPaneTitle(page: Page, title: string): Promise<void> {
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  await page
    .locator('.xterm:visible')
    .first()
    .click({
      button: isMac ? 'left' : 'right',
      position: { x: 40, y: 40 },
      modifiers: isMac ? ['Control'] : []
    })
  await page.getByText('Set Title…', { exact: true }).click()
  const titleInput = page.getByRole('textbox', { name: 'Pane title' })
  await expect(titleInput).toBeVisible()
  await titleInput.fill(title)
  await titleInput.press('Enter')
  await expect(titleInput).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Edit pane title: ${title}` })).toBeVisible()
}

test('retries an identical remote pane layout after reconnect', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const title = `Reconnect retry ${Date.now()}`
  const host = await launchHeadlessPairedRuntimeHost()
  let client: PairedElectronClient | null = null
  let observer: PairedElectronClient | null = null
  let terminal: string | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Pane layout retry client')
    await expect
      .poll(
        () =>
          client?.page.evaluate(() => window.__store?.getState().allWorktrees().length ?? 0) ?? 0,
        { timeout: 60_000, message: 'paired client never saw a host worktree' }
      )
      .toBeGreaterThan(0)
    const worktreeId = await client.page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? null
    )
    if (!worktreeId) {
      throw new Error('Paired client did not receive the host worktree')
    }

    const created = await callEnvironment<{
      tab: { parentTabId: string; terminal: string | null }
    }>(client.page, client.environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      activate: false,
      select: false,
      navigation: 'caller'
    })
    terminal = created.tab.terminal
    if (!terminal) {
      throw new Error('Host terminal was not created')
    }
    const hostTabId = created.tab.parentTabId
    const webTabId = toWebTerminalSurfaceTabId(hostTabId)
    await openClientTab(client.page, worktreeId, webTabId)

    const terminalRoot = client.page.locator(`[data-terminal-tab-id="${webTabId}"]`).first()
    await terminalRoot.evaluate((element) => {
      element.setAttribute('data-layout-retry-owner', 'original')
    })
    await client.page.evaluate(async (selector) => {
      await window.api.runtimeEnvironments.disconnect({ selector })
    }, client.environmentId)

    const failedPush = client.page.waitForEvent('console', {
      predicate: (message) =>
        message.type() === 'warning' &&
        message.text().includes('[web-runtime-session] failed to update pane layout:'),
      timeout: 30_000
    })
    await setPaneTitle(client.page, title)
    await failedPush
    const failedLayout = await readClientLayout(client.page, webTabId)
    expect(Object.values(failedLayout?.titlesByLeafId ?? {})).toContain(title)
    expect(
      Object.values((await readHostLayout(host, worktreeId, hostTabId))?.titlesByLeafId ?? {})
    ).not.toContain(title)

    await expect
      .poll(
        () =>
          client.page.evaluate(async (selector) => {
            const response = await window.api.runtimeEnvironments.connect({ selector })
            return response.ok
          }, client.environmentId),
        { timeout: 60_000, message: 'paired client never reconnected to the host runtime' }
      )
      .toBe(true)
    await expect(terminalRoot).toHaveAttribute('data-layout-retry-owner', 'original')

    await setPaneTitle(client.page, title)
    expect(await readClientLayout(client.page, webTabId)).toEqual(failedLayout)
    await expect
      .poll(
        async () =>
          Object.values(
            (await readHostLayout(host, worktreeId, hostTabId))?.titlesByLeafId ?? {}
          ).includes(title),
        { timeout: 30_000, message: 'headless host never persisted the retried pane layout' }
      )
      .toBe(true)

    observer = await launchPairedElectronClient(host.offer, testInfo, 'Pane layout retry observer')
    await openClientTab(observer.page, worktreeId, webTabId)
    await expect(
      observer.page.getByRole('button', { name: `Edit pane title: ${title}` })
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await observer?.dispose()
    if (terminal) {
      await host.client.call('terminal.closeTab', { terminal }).catch(() => undefined)
    }
    await client?.dispose()
    await host.dispose()
  }
})
