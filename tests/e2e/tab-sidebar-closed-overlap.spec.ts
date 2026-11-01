// #1066/#1112: collapsed-sidebar floating chrome must not cover the first tab.
// Measure the whole header including navigation, then require both clearing geometry and a successful tab-center hit test.

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

test.describe('Tab visibility with closed sidebar', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('first tab stays visible after Cmd+B collapses the sidebar', async ({ orcaPage }) => {
    // Use Cmd/Ctrl+B so broken binding/editable-target routing cannot pass via direct state setup.

    // Require terminal view and initially open sidebar to exercise the actual open→collapsed transition.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              // Fail a missing exposed store explicitly instead of timing out on downstream state.
              throw new Error('window.__store is not available — is the app in dev mode?')
            }
            const state = store.getState()
            return { activeView: state.activeView, sidebarOpen: state.sidebarOpen }
          }),
        {
          timeout: 5_000,
          message: 'Expected default activeView=terminal and sidebarOpen=true at test start'
        }
      )
      .toEqual({ activeView: 'terminal', sidebarOpen: true })

    // Blur non-xterm editable focus so the chord reaches sidebar toggle instead of an editor’s bold keymap.
    await orcaPage.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement && !active.classList.contains('xterm-helper-textarea')) {
        active.blur()
      }
    })

    await pressShortcut(orcaPage, 'b')

    // Poll closed state before layout measurement; React and ResizeObserver settle on later frames.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available — is the app in dev mode?')
            }
            return store.getState().sidebarOpen
          }),
        {
          timeout: 5_000,
          message: 'Cmd/Ctrl+B did not collapse the sidebar — keymap binding may be broken'
        }
      )
      .toBe(false)

    const measureLayout = async (): Promise<{
      titlebarRight: number
      titlebarWidth: number
      firstTabLeft: number
      firstTabWidth: number
      centerIsTabOrDescendant: boolean
    } | null> =>
      orcaPage.evaluate(() => {
        const titlebarLeft = document.querySelector<HTMLElement>('.titlebar-left')
        // Pick the visually leftmost tab because split-group DOM order need not match screen order.
        const allTabs = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"]')
        )
        if (!titlebarLeft || allTabs.length === 0) {
          return null
        }
        // Wait for the absolute collapsed header branch; the flex-flow header cannot exhibit this overlap.
        if (getComputedStyle(titlebarLeft).position !== 'absolute') {
          return null
        }
        const firstTab = allTabs.reduce((leftmost, candidate) =>
          candidate.getBoundingClientRect().left < leftmost.getBoundingClientRect().left
            ? candidate
            : leftmost
        )
        const tlRect = titlebarLeft.getBoundingClientRect()
        const tabRect = firstTab.getBoundingClientRect()
        // Hit-test the tab center too so z-index/pointer-event overlays cannot pass on geometry alone.
        const centerX = tabRect.left + tabRect.width / 2
        const centerY = tabRect.top + tabRect.height / 2
        const elAtCenter = document.elementFromPoint(centerX, centerY)
        return {
          titlebarRight: tlRect.right,
          titlebarWidth: tlRect.width,
          firstTabLeft: tabRect.left,
          firstTabWidth: tabRect.width,
          centerIsTabOrDescendant: elAtCenter !== null && firstTab.contains(elAtCenter)
        }
      })

    // Capture geometry inside the successful poll tick; a separate read can race ResizeObserver and return null.
    let geometry: {
      titlebarRight: number
      titlebarWidth: number
      firstTabLeft: number
      firstTabWidth: number
      centerIsTabOrDescendant: boolean
    } | null = null
    await expect
      .poll(
        async () => {
          geometry = await measureLayout()
          if (!geometry) {
            return false
          }
          return geometry.titlebarWidth > 0 && geometry.firstTabWidth > 0
        },
        {
          timeout: 5_000,
          message: 'Floating titlebar / first tab never reached a measurable collapsed-layout state'
        }
      )
      .toBe(true)

    expect(geometry).not.toBeNull()
    const { titlebarRight, firstTabLeft, centerIsTabOrDescendant } = geometry!

    // Allow only 1px rounding slack; the old missing navigation measured about 55px.
    expect(firstTabLeft).toBeGreaterThanOrEqual(titlebarRight - 1)

    expect(centerIsTabOrDescendant).toBe(true)
  })

  test('sidebar toggle and Back button stay separated after sidebar collapse', async ({
    orcaPage
  }) => {
    await orcaPage.addInitScript(() => {
      // Why: #2082 was reported against Windows-only titlebar chrome. Reloading
      // with a Windows UA makes App.tsx take that renderer branch on any CI host.
      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36'
      Object.defineProperty(navigator, 'userAgent', {
        get: () => userAgent,
        configurable: true
      })
    })
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => ({
            hasWindowsUserAgent: navigator.userAgent.includes('Windows'),
            hasWindowsTitlebarChrome:
              Boolean(document.querySelector('button[aria-label="Application menu"]')) &&
              Boolean(document.querySelector('.window-controls'))
          })),
        {
          timeout: 5_000,
          message: 'Renderer did not switch to the Windows titlebar branch'
        }
      )
      .toEqual({ hasWindowsUserAgent: true, hasWindowsTitlebarChrome: true })

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available — is the app in dev mode?')
      }
      store.getState().setSidebarOpen(true)
    })

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available — is the app in dev mode?')
            }
            const state = store.getState()
            return { activeView: state.activeView, sidebarOpen: state.sidebarOpen }
          }),
        {
          timeout: 5_000,
          message: 'Expected default activeView=terminal and sidebarOpen=true at test start'
        }
      )
      .toEqual({ activeView: 'terminal', sidebarOpen: true })

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available — is the app in dev mode?')
      }
      // Drive collapsed state directly for this geometry arm because hidden animated chrome may never become Playwright-stable.
      store.getState().setSidebarOpen(false)
    })

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available — is the app in dev mode?')
            }
            return store.getState().sidebarOpen
          }),
        {
          timeout: 5_000,
          message: 'Sidebar did not enter the collapsed state'
        }
      )
      .toBe(false)

    const measureControls = async (): Promise<{
      titlebarIsCollapsed: boolean
      toggleRight: number
      backLeft: number
      backCenterHitsBack: boolean
    } | null> =>
      orcaPage.evaluate(() => {
        const titlebarLeft = document.querySelector<HTMLElement>('.titlebar-left')
        const sidebarToggle = titlebarLeft?.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle sidebar"]'
        )
        const backButton = titlebarLeft?.querySelector<HTMLButtonElement>(
          'button[aria-label="Go back"]'
        )
        if (!titlebarLeft || !sidebarToggle || !backButton) {
          return null
        }
        const titlebarIsCollapsed = getComputedStyle(titlebarLeft).position === 'absolute'
        const toggleRect = sidebarToggle.getBoundingClientRect()
        const backRect = backButton.getBoundingClientRect()
        const backCenterX = backRect.left + backRect.width / 2
        const backCenterY = backRect.top + backRect.height / 2
        const elementAtBackCenter = document.elementFromPoint(backCenterX, backCenterY)
        return {
          titlebarIsCollapsed,
          toggleRight: toggleRect.right,
          backLeft: backRect.left,
          backCenterHitsBack:
            elementAtBackCenter !== null && backButton.contains(elementAtBackCenter)
        }
      })

    let controls: {
      titlebarIsCollapsed: boolean
      toggleRight: number
      backLeft: number
      backCenterHitsBack: boolean
    } | null = null
    await expect
      .poll(
        async () => {
          controls = await measureControls()
          return controls?.titlebarIsCollapsed === true
        },
        {
          timeout: 5_000,
          message: 'Titlebar controls never reached a measurable collapsed-layout state'
        }
      )
      .toBe(true)

    expect(controls).not.toBeNull()
    const { toggleRight, backLeft, backCenterHitsBack } = controls!

    // Require a Windows header gutter where ml-auto has no spare width to separate Back.
    expect(backLeft - toggleRight).toBeGreaterThanOrEqual(6)
    expect(backCenterHitsBack).toBe(true)
  })
})
