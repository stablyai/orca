import type { Page } from '@stablyai/playwright-test'
import {
  BROWSER_DIRECT_HISTORY_NAVIGATION_RUNTIME_CAPABILITY,
  BROWSER_DIRECT_RAW_INPUT_RUNTIME_CAPABILITY
} from '../../src/shared/protocol-version'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
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
      const tab = state.createBrowserTab(worktreeId, 'about:blank', {
        title: 'Legacy remote input',
        browserRuntimeEnvironmentId: environmentId
      })
      const pageId = tab.activePageId ?? tab.pageIds?.[0]
      if (!pageId) {
        throw new Error('client browser page unavailable')
      }
      state.setRemoteBrowserPageHandle(pageId, { environmentId, remotePageId })
      state.setActiveWorktree(worktreeId)
      state.focusBrowserTabInWorktree(worktreeId, tab.id, { surfacePane: true })
    },
    { environmentId, worktreeId, remotePageId }
  )
}

test('keeps click, wheel, and keyboard usable when the host lacks direct raw input', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost({
    extraEnv: {
      ORCA_E2E_DISABLE_BROWSER_DIRECT_HISTORY_NAVIGATION: '1',
      ORCA_E2E_DISABLE_BROWSER_DIRECT_RAW_INPUT: '1'
    }
  })
  let client: PairedElectronClient | null = null

  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Legacy remote browser input')
    const page = client.page
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().allWorktrees()[0]?.id ?? null), {
        timeout: 60_000
      })
      .not.toBeNull()
    const worktreeId = await page.evaluate(
      () => window.__store?.getState().allWorktrees()[0]?.id ?? ''
    )
    const status = await callEnvironment<{ capabilities?: string[] }>(
      page,
      client.environmentId,
      'status.get',
      {}
    )
    expect(status.capabilities).not.toContain(BROWSER_DIRECT_RAW_INPUT_RUNTIME_CAPABILITY)
    expect(status.capabilities).not.toContain(BROWSER_DIRECT_HISTORY_NAVIGATION_RUNTIME_CAPABILITY)

    const created = await callEnvironment<{ browserPageId: string }>(
      page,
      client.environmentId,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: 'about:blank', activate: true }
    )
    const target = { worktree: `id:${worktreeId}`, page: created.browserPageId }
    await callEnvironment(page, client.environmentId, 'browser.eval', {
      ...target,
      expression: `(() => {
        document.body.innerHTML = '<button id="target">Click</button><input id="field">';
        document.body.style.minHeight = '3000px';
        const button = document.getElementById('target');
        button.style.cssText = 'position:fixed;left:20px;top:20px;width:100px;height:40px';
        button.onclick = () => {
          document.body.dataset.clicked = 'yes';
          history.pushState({}, '', '#clicked');
        };
      })()`
    })
    await attachRemoteBrowserPane(page, client.environmentId, worktreeId, created.browserPageId)

    const frame = page.getByTestId('remote-browser-frame').first()
    await expect(frame).toBeVisible({ timeout: 60_000 })
    await frame.click({ position: { x: 50, y: 35 } })
    await expect
      .poll(() =>
        callEnvironment<{ result: string }>(page, client!.environmentId, 'browser.eval', {
          ...target,
          expression: 'document.body.dataset.clicked'
        }).then((result) => result.result)
      )
      .toBe('yes')
    await expect
      .poll(() =>
        callEnvironment<{ result: string }>(page, client!.environmentId, 'browser.eval', {
          ...target,
          expression: 'location.hash'
        }).then((result) => result.result)
      )
      .toBe('#clicked')

    await page
      .locator('[data-contextual-tour-target="browser-toolbar"]')
      .getByRole('button')
      .first()
      .click()
    await expect
      .poll(() =>
        callEnvironment<{ result: string }>(page, client!.environmentId, 'browser.eval', {
          ...target,
          expression: 'location.hash'
        }).then((result) => result.result)
      )
      .toBe('')

    const box = await frame.boundingBox()
    if (!box) {
      throw new Error('remote frame bounds unavailable')
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 600)
    await expect
      .poll(() =>
        callEnvironment<{ result: string }>(page, client!.environmentId, 'browser.eval', {
          ...target,
          expression: 'window.scrollY'
        }).then((result) => Number(result.result))
      )
      .toBeGreaterThan(0)

    await callEnvironment(page, client.environmentId, 'browser.eval', {
      ...target,
      expression: `document.getElementById('field').focus()`
    })
    await frame.focus()
    await page.keyboard.type('abc')
    await expect
      .poll(() =>
        callEnvironment<{ result: string }>(page, client!.environmentId, 'browser.eval', {
          ...target,
          expression: `document.getElementById('field').value`
        }).then((result) => result.result)
      )
      .toBe('abc')

    await expect(page.getByTestId('remote-browser-stream-error')).toHaveCount(0)
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
