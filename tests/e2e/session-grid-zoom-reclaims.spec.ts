// A grid card's terminal re-claims its PTY grid after every zoom change: the rendered screen spans
// the box to within one cell with no scale transform, rather than a stale grid scaled to fit.

import { writeFileSync } from 'node:fs'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const CARD = '[data-testid="session-grid-card"]'

type CardFit = {
  tabId: string
  boxWidth: number
  screenWidth: number
  cellWidth: number
  transform: string
  claim: string
  snapshot: string
}

async function readCardFits(page: Page): Promise<CardFit[]> {
  return page.evaluate((cardSelector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(cardSelector)).map((card) => {
      const container = card.querySelector<HTMLElement>('.origin-bottom-left')
      const box = container?.parentElement
      const screen = card.querySelector<HTMLElement>('.xterm-screen')
      const cols = Number(card.querySelector<HTMLElement>('.xterm')?.dataset.cols ?? 0)
      const screenWidth = screen?.offsetWidth ?? 0
      return {
        tabId: card.dataset.tabId ?? '',
        boxWidth: box?.clientWidth ?? 0,
        screenWidth,
        cellWidth: cols > 0 ? screenWidth / cols : 0,
        transform: container?.style.transform ?? '',
        claim: `${container?.dataset.claimStatus ?? '?'}:${container?.dataset.claimApplied ?? '?'}`,
        snapshot: `${container?.dataset.snapshotSource ?? '?'}:${container?.dataset.snapshotGrid ?? '?'}`
      }
    })
  }, CARD)
}

async function expectEveryCardFilled(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const fits = await readCardFits(page)
        const wrong = fits.filter(
          (fit) =>
            fit.boxWidth === 0 ||
            fit.screenWidth === 0 ||
            fit.transform !== '' ||
            // The claim landed 1:1 and the frame on screen is that very grid.
            !fit.claim.startsWith('settled:') ||
            fit.snapshot.split(':')[1] !== fit.claim.split(':')[1] ||
            fit.boxWidth - fit.screenWidth > Math.max(fit.cellWidth, 12) + 1
        )
        return wrong.length === 0 ? 'all-filled' : JSON.stringify({ label, wrong })
      },
      { timeout: 20_000, message: `cards should fill their boxes (${label})` }
    )
    .toBe('all-filled')
}

test('cards re-negotiate their columns after a zoom change', async ({ orcaPage }) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  await orcaPage.evaluate((worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    const have = (state.tabsByWorktree[worktreeId] ?? []).length
    for (let i = have; i < 4; i += 1) {
      state.createTab(worktreeId, undefined, undefined, {
        activate: false,
        id: `session-grid-zoom-${i}`
      })
    }
    store.setState({
      sessionsGridPreset: '2x2',
      sessionsGridScrollMode: 'row',
      sessionsGridZoom: 1
    })
    state.openSessionsPage()
  }, worktreeId)
  await expect(orcaPage.locator(`${CARD} .xterm`)).toHaveCount(4, { timeout: 20_000 })
  await expectEveryCardFilled(orcaPage, 'zoom 1')

  await orcaPage.evaluate(() => window.__store!.getState().setSessionsGridZoom(0.8))
  await expectEveryCardFilled(orcaPage, 'zoom 0.8')

  await orcaPage.evaluate(() => window.__store!.getState().setSessionsGridZoom(1.2))
  await expectEveryCardFilled(orcaPage, 'zoom 1.2')
})

test('short windows keep row cards readable and the last row reachable', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await electronApp.evaluate(({ BrowserWindow }) => {
    if (BrowserWindow.getAllWindows().some((window) => window.isVisible())) {
      throw new Error('Validation windows must remain hidden')
    }
  })
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false
  })
  await orcaPage.emulateMedia({ reducedMotion: 'reduce' })
  const lastTabId = await orcaPage.evaluate(async (worktreeId) => {
    const store = window.__store!
    const state = store.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    const existing = state.tabsByWorktree[worktreeId] ?? []
    let lastTabId = existing.at(-1)?.id ?? ''
    for (let i = existing.length; i < 9; i += 1) {
      const tab = state.createTab(worktreeId, undefined, undefined, {
        activate: false,
        id: `short-grid-${i}`
      })
      if (tab) {
        lastTabId = tab.id
      }
    }
    store.setState({
      sessionsGridPreset: '3x3',
      sessionsGridScrollMode: 'row',
      sessionsGridShowEmpty: false,
      sessionsGridFilter: worktreeId
    })
    state.openSessionsPage()
    return lastTabId
  }, worktreeId)
  for (const mode of ['row', 'free'] as const) {
    await orcaPage.evaluate(
      (mode) => window.__store!.getState().setSessionsGridScrollMode(mode),
      mode
    )
    await orcaPage
      .locator('#session-grid-scroll-container')
      .evaluate((el) => el.scrollTo({ top: 0, behavior: 'auto' }))
    const next = orcaPage.getByRole('button', { name: 'Next page', exact: true })
    await expect(next).toBeEnabled()
    await expect
      .poll(() =>
        orcaPage
          .locator(CARD)
          .first()
          .evaluate((el) => el.getBoundingClientRect().height)
      )
      .toBeGreaterThanOrEqual(200)
    await next.click()
    await next.click()
    await expect(next).toBeDisabled()
    const lastCard = orcaPage.locator(`${CARD}[data-tab-id="${lastTabId}"]`)
    await expect(lastCard).toBeInViewport({ ratio: 0.9 })
  }
  const lastCard = orcaPage.locator(`${CARD}[data-tab-id="${lastTabId}"]`)
  await expect(lastCard.locator('.xterm')).toBeVisible({ timeout: 20_000 })
  await lastCard.locator('.xterm').click()
  await orcaPage.keyboard.type('echo readable-last-row')
  await orcaPage.keyboard.press('Enter')
  await expect(lastCard).toContainText('readable-last-row')
  for (const theme of ['dark', 'light'] as const) {
    await orcaPage.evaluate(
      async (theme) => window.__store!.getState().updateSettings({ theme }),
      theme
    )
    await expect
      .poll(() => orcaPage.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(theme === 'dark')
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = testInfo.outputPath(`short-grid-${theme}.png`)
    writeFileSync(screenshotPath, Buffer.from(data, 'base64'))
    await testInfo.attach(`short-grid-${theme}`, { path: screenshotPath, contentType: 'image/png' })
  }
  await cdp.detach()
})
