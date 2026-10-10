// Mouse Back/Forward over a local browser page drive that page's history, never worktree history.

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createTerminalBrowserSplit } from './helpers/browser-split-fixture'
import {
  navigateGuest,
  waitForGuestIdle,
  waitForGuestUrl
} from './helpers/browser-split-guest-probes'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'
import { hostHistoryProbeIsCurrent, pushHostHistoryProbe } from './helpers/host-history-probe'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  getStoreState,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'

type MouseSideButton = 'back' | 'forward'

async function guestWebContentsId(page: Page, browserTabId: string): Promise<number> {
  return page.evaluate((tabId) => {
    const webview = document.querySelector<Electron.WebviewTag>(
      `[data-browser-overlay-tab-id="${tabId}"] webview`
    )
    if (!webview) {
      throw new Error('Browser guest unavailable')
    }
    return webview.getWebContentsId()
  }, browserTabId)
}

/** Delivers the button straight to the guest, the way real input over its surface arrives. */
async function clickSideButtonInGuest(
  electronApp: ElectronApplication,
  webContentsId: number,
  button: MouseSideButton
): Promise<void> {
  await electronApp.evaluate(
    async ({ webContents }, { targetId, targetButton }) => {
      const guest = webContents.fromId(targetId)
      if (!guest) {
        throw new Error(`Missing guest webContents ${targetId}`)
      }
      const attachedHere = !guest.debugger.isAttached()
      if (attachedHere) {
        guest.debugger.attach('1.3')
      }
      try {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
            type,
            x: 20,
            y: 20,
            button: targetButton,
            clickCount: 1
          })
        }
      } finally {
        if (attachedHere) {
          guest.debugger.detach()
        }
      }
    },
    { targetId: webContentsId, targetButton: button }
  )
}

async function worktreeHistoryIndex(page: Page): Promise<number> {
  return getStoreState<number>(page, 'worktreeNavHistoryIndex')
}

/** Ends history on the active worktree with somewhere to go back to, so a stray step shows. */
async function seedNavigableWorktreeHistory(page: Page): Promise<void> {
  const activeId = await getActiveWorktreeId(page)
  const otherId = (await getAllWorktreeIds(page)).find((id) => id !== activeId)
  if (!activeId || !otherId) {
    throw new Error('Need two worktrees to seed navigable history')
  }
  await page.evaluate(
    ({ first, last }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store unavailable')
      }
      store.setState({ worktreeNavHistory: [], worktreeNavHistoryIndex: -1 })
      store.getState().recordWorktreeVisit(first)
      store.getState().recordWorktreeVisit(last)
    },
    { first: otherId, last: activeId }
  )
  expect(await worktreeHistoryIndex(page)).toBe(1)
}

/** Center of an element in the main renderer, for CDP input; waits for it to be laid out. */
async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const readCenter = (): Promise<{ x: number; y: number } | null> =>
    page.evaluate((target) => {
      const rect = document.querySelector(target)?.getBoundingClientRect()
      return rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null
    }, selector)
  await expect.poll(readCenter, { message: `${selector} never got a layout box` }).not.toBeNull()
  const point = await readCenter()
  if (!point) {
    throw new Error(`${selector} lost its layout box`)
  }
  return point
}

async function clickSideButtonInHost(
  page: Page,
  point: { x: number; y: number },
  button: MouseSideButton
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...point, button, clickCount: 1 })
    }
  } finally {
    await cdp.detach()
  }
}

test.describe('browser mouse Back/Forward', () => {
  let server: BrowserSplitPageServer

  test.beforeEach(async ({ orcaPage }) => {
    server = await startBrowserSplitPageServer()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async () => {
    await server.close()
  })

  test('side buttons pressed in a local page navigate that page only', async ({
    orcaPage,
    electronApp
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('a', 1))
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))
    await navigateGuest(orcaPage, fixture.browserTabId, server.pageUrl('a', 2))
    await waitForGuestIdle(orcaPage, fixture.browserTabId)
    await seedNavigableWorktreeHistory(orcaPage)
    const worktreeBefore = await getActiveWorktreeId(orcaPage)
    const guestId = await guestWebContentsId(orcaPage, fixture.browserTabId)

    await clickSideButtonInGuest(electronApp, guestId, 'back')
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))

    await clickSideButtonInGuest(electronApp, guestId, 'forward')
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 2))

    expect(await getActiveWorktreeId(orcaPage)).toBe(worktreeBefore)
    expect(await worktreeHistoryIndex(orcaPage)).toBe(1)
  })

  test('a press the host sees over a local page leaves worktree history alone', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('a', 1))
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))
    await navigateGuest(orcaPage, fixture.browserTabId, server.pageUrl('a', 2))
    await waitForGuestIdle(orcaPage, fixture.browserTabId)
    await seedNavigableWorktreeHistory(orcaPage)
    const worktreeBefore = await getActiveWorktreeId(orcaPage)
    await pushHostHistoryProbe(orcaPage)

    await clickSideButtonInHost(
      orcaPage,
      await centerOf(orcaPage, `[data-browser-overlay-tab-id="${fixture.browserTabId}"] webview`),
      'back'
    )

    await orcaPage.waitForTimeout(300)
    expect(await getActiveWorktreeId(orcaPage)).toBe(worktreeBefore)
    expect(await worktreeHistoryIndex(orcaPage)).toBe(1)
    expect(await hostHistoryProbeIsCurrent(orcaPage)).toBe(true)
  })

  test('Back over a split divider that cancels pointerdown steps worktree history', async ({
    orcaPage
  }) => {
    await createTerminalBrowserSplit(orcaPage, server.pageUrl('a', 1))
    await seedNavigableWorktreeHistory(orcaPage)
    const [previousId] = await getStoreState<string[]>(orcaPage, 'worktreeNavHistory')
    await pushHostHistoryProbe(orcaPage)

    // Why the divider: its pointerdown calls preventDefault, which suppresses compat mouse events.
    await clickSideButtonInHost(
      orcaPage,
      await centerOf(orcaPage, '.tab-group-split-resize-handle'),
      'back'
    )

    await expect.poll(async () => getActiveWorktreeId(orcaPage)).toBe(previousId)
    expect(await hostHistoryProbeIsCurrent(orcaPage)).toBe(true)
  })
})
