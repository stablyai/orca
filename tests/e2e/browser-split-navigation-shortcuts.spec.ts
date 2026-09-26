// STA-8147: history, reload, zoom, and address-bar chords act on the split that sent them.

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  browserAddressBar,
  browserOverlay,
  createBrowserSplit,
  createTerminalBrowserSplit,
  focusBrowserGroup,
  guestModifier,
  pressKeyInBrowserGuest,
  shortcutModifier,
  waitForFocusedGroup,
  type BrowserSplitFixture,
  type GuestModifier
} from './helpers/browser-split-fixture'
import {
  guestLoadStarts,
  guestUrl,
  guestZoomLevel,
  navigateGuest,
  recordGuestLoadStarts,
  waitForGuestIdle,
  waitForGuestUrl
} from './helpers/browser-split-guest-probes'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'

type Chord = { renderer: string; guestKeyCode: string; guestModifiers: GuestModifier[] }

const isMac = process.platform === 'darwin'
// Default bindings for browser.back / browser.forward / browser.reload / browser.hardReload.
const backChord: Chord = isMac
  ? { renderer: 'Meta+BracketLeft', guestKeyCode: '[', guestModifiers: ['meta'] }
  : { renderer: 'Alt+ArrowLeft', guestKeyCode: 'Left', guestModifiers: ['alt'] }
const forwardChord: Chord = isMac
  ? { renderer: 'Meta+BracketRight', guestKeyCode: ']', guestModifiers: ['meta'] }
  : { renderer: 'Alt+ArrowRight', guestKeyCode: 'Right', guestModifiers: ['alt'] }
const reloadChord: Chord = {
  renderer: `${shortcutModifier}+r`,
  guestKeyCode: 'R',
  guestModifiers: [guestModifier]
}
const hardReloadChord: Chord = {
  renderer: `${shortcutModifier}+Shift+R`,
  guestKeyCode: 'R',
  guestModifiers: [guestModifier, 'shift']
}

async function pressInGuest(
  page: Page,
  fixture: BrowserSplitFixture,
  chord: Pick<Chord, 'guestKeyCode' | 'guestModifiers'>
): Promise<void> {
  await pressKeyInBrowserGuest(
    page,
    fixture.firstBrowserTabId,
    fixture.firstBrowserPageId,
    chord.guestKeyCode,
    chord.guestModifiers
  )
}

/** Two browser splits, each on its second page so both have somewhere to go back to. */
async function createBrowserSplitWithHistory(
  page: Page,
  server: BrowserSplitPageServer
): Promise<BrowserSplitFixture> {
  const fixture = await createBrowserSplit(page, {
    first: server.pageUrl('a', 1),
    second: server.pageUrl('b', 1, 'localhost')
  })
  await waitForGuestUrl(page, fixture.firstBrowserTabId, server.pageUrl('a', 1))
  await waitForGuestUrl(page, fixture.secondBrowserTabId, server.pageUrl('b', 1, 'localhost'))
  await navigateGuest(page, fixture.firstBrowserTabId, server.pageUrl('a', 2))
  await navigateGuest(page, fixture.secondBrowserTabId, server.pageUrl('b', 2, 'localhost'))
  await waitForGuestIdle(page, fixture.firstBrowserTabId)
  await waitForGuestIdle(page, fixture.secondBrowserTabId)
  await recordGuestLoadStarts(page, [fixture.firstBrowserTabId, fixture.secondBrowserTabId])
  return fixture
}

async function expectSecondSplitUntouched(
  page: Page,
  fixture: BrowserSplitFixture,
  server: BrowserSplitPageServer
): Promise<void> {
  await waitForGuestIdle(page, fixture.firstBrowserTabId)
  expect(await guestLoadStarts(page, fixture.secondBrowserTabId)).toBe(0)
  expect(await guestUrl(page, fixture.secondBrowserTabId)).toBe(server.pageUrl('b', 2, 'localhost'))
}

async function expectFirstSplitReloaded(page: Page, fixture: BrowserSplitFixture): Promise<void> {
  await expect.poll(() => guestLoadStarts(page, fixture.firstBrowserTabId)).toBeGreaterThan(0)
}

test.describe('browser split navigation shortcuts', () => {
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

  test('Back and Forward typed in one guest move only that split', async ({ orcaPage }) => {
    const fixture = await createBrowserSplitWithHistory(orcaPage, server)

    await pressInGuest(orcaPage, fixture, backChord)
    await waitForGuestUrl(orcaPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    await expectSecondSplitUntouched(orcaPage, fixture, server)

    await pressInGuest(orcaPage, fixture, forwardChord)
    await waitForGuestUrl(orcaPage, fixture.firstBrowserTabId, server.pageUrl('a', 2))
    await expectSecondSplitUntouched(orcaPage, fixture, server)
  })

  test('Reload and Hard Reload typed in one guest reload only that split', async ({ orcaPage }) => {
    const fixture = await createBrowserSplitWithHistory(orcaPage, server)

    await pressInGuest(orcaPage, fixture, reloadChord)
    await expectFirstSplitReloaded(orcaPage, fixture)
    await expectSecondSplitUntouched(orcaPage, fixture, server)

    await recordGuestLoadStarts(orcaPage, [fixture.firstBrowserTabId])
    await pressInGuest(orcaPage, fixture, hardReloadChord)
    await expectFirstSplitReloaded(orcaPage, fixture)
    await expectSecondSplitUntouched(orcaPage, fixture, server)
    expect(await guestUrl(orcaPage, fixture.firstBrowserTabId)).toBe(server.pageUrl('a', 2))
  })

  // Ctrl+wheel is not covered: before-mouse-event only fires for OS input, not sendInputEvent.
  test('page zoom typed in one guest zooms only that split', async ({ orcaPage }) => {
    const fixture = await createBrowserSplitWithHistory(orcaPage, server)
    const firstZoom = (): Promise<number | null> =>
      guestZoomLevel(orcaPage, fixture.firstBrowserTabId)
    const secondZoom = (): Promise<number | null> =>
      guestZoomLevel(orcaPage, fixture.secondBrowserTabId)
    const initialFirstZoom = await firstZoom()
    const initialSecondZoom = await secondZoom()
    expect(initialFirstZoom).not.toBeNull()

    await pressInGuest(orcaPage, fixture, { guestKeyCode: '=', guestModifiers: [guestModifier] })
    await expect.poll(firstZoom).toBeGreaterThan(initialFirstZoom ?? 0)
    expect(await secondZoom()).toBe(initialSecondZoom)

    await pressInGuest(orcaPage, fixture, { guestKeyCode: '-', guestModifiers: [guestModifier] })
    await pressInGuest(orcaPage, fixture, { guestKeyCode: '-', guestModifiers: [guestModifier] })
    await expect.poll(firstZoom).toBeLessThan(initialFirstZoom ?? 0)
    expect(await secondZoom()).toBe(initialSecondZoom)
  })

  test('Focus Address Bar typed in one guest focuses only that split', async ({ orcaPage }) => {
    const fixture = await createBrowserSplitWithHistory(orcaPage, server)

    await pressInGuest(orcaPage, fixture, { guestKeyCode: 'L', guestModifiers: [guestModifier] })

    await expect(browserAddressBar(orcaPage, fixture.firstBrowserTabId)).toBeFocused()
    await expect(browserAddressBar(orcaPage, fixture.secondBrowserTabId)).not.toBeFocused()
  })

  test('Back and Reload pressed from one split toolbar act on only that split', async ({
    orcaPage
  }) => {
    const fixture = await createBrowserSplitWithHistory(orcaPage, server)
    const reloadButton = browserOverlay(orcaPage, fixture.firstBrowserTabId).getByRole('button', {
      name: 'Reload',
      exact: true
    })

    await reloadButton.focus()
    await waitForFocusedGroup(orcaPage, fixture.firstBrowserGroupId)
    await orcaPage.keyboard.press(backChord.renderer)
    await waitForGuestUrl(orcaPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    await expectSecondSplitUntouched(orcaPage, fixture, server)

    await recordGuestLoadStarts(orcaPage, [fixture.firstBrowserTabId])
    await reloadButton.focus()
    await orcaPage.keyboard.press(reloadChord.renderer)
    await expectFirstSplitReloaded(orcaPage, fixture)
    await expectSecondSplitUntouched(orcaPage, fixture, server)
  })

  test('Back and Reload pressed in a focused terminal leave the browser split alone', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('a', 1))
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))
    await navigateGuest(orcaPage, fixture.browserTabId, server.pageUrl('a', 2))
    await waitForGuestIdle(orcaPage, fixture.browserTabId)
    await recordGuestLoadStarts(orcaPage, [fixture.browserTabId])

    await focusBrowserGroup(orcaPage, fixture.terminalGroupId)
    await focusActiveTerminalInput(orcaPage)
    await waitForFocusedGroup(orcaPage, fixture.terminalGroupId)
    await orcaPage.keyboard.press(backChord.renderer)
    await orcaPage.keyboard.press(reloadChord.renderer)
    await orcaPage.keyboard.press(hardReloadChord.renderer)
    // Why: the next toolbar press proves these chords reach the pane in this app; it only has to lose here.
    const reloadButton = browserOverlay(orcaPage, fixture.browserTabId).getByRole('button', {
      name: 'Reload',
      exact: true
    })
    await waitForGuestIdle(orcaPage, fixture.browserTabId)
    expect(await guestLoadStarts(orcaPage, fixture.browserTabId)).toBe(0)
    expect(await guestUrl(orcaPage, fixture.browserTabId)).toBe(server.pageUrl('a', 2))

    await reloadButton.focus()
    await waitForFocusedGroup(orcaPage, fixture.browserGroupId)
    await orcaPage.keyboard.press(backChord.renderer)
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))
  })
})
