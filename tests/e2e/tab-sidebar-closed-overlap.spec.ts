// #1066/#1112: collapsed-sidebar floating chrome must not cover the first tab.
// Measure the whole header including navigation, then require both clearing geometry and a successful tab-center hit test.

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

test.describe('Sidebar boundaries beside terminal content', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('sidebar resize and scrollbar targets remain reachable over a terminal', async ({
    orcaPage
  }) => {
    const handle = orcaPage.locator('[data-sidebar-resize-handle]')
    const strip = orcaPage.locator('[data-sidebar-seam-scrollbar-strip]')
    await expect(handle).toBeVisible()
    await expect(orcaPage.locator('.xterm:visible').first()).toBeVisible()

    const terminalBox = await orcaPage.locator('.xterm:visible').first().boundingBox()
    const handleBox = await handle.boundingBox()
    const stripBox = await strip.boundingBox()
    expect(terminalBox).not.toBeNull()
    expect(handleBox).not.toBeNull()
    expect(stripBox).not.toBeNull()
    const y = terminalBox!.y + terminalBox!.height / 2

    for (const [target, box] of [
      [handle, handleBox!],
      [strip, stripBox!]
    ] as const) {
      const reachable = await target.evaluate(
        (element, point) => element.contains(document.elementFromPoint(point.x, point.y)),
        { x: box.x + box.width / 2, y }
      )
      expect(reachable).toBe(true)
    }

    const x = handleBox!.x + handleBox!.width / 2
    await orcaPage.mouse.move(x, y)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(x + 40, y, { steps: 5 })
    await orcaPage.mouse.up()

    await expect
      .poll(async () => Math.round((await handle.boundingBox())!.x - handleBox!.x))
      .toBe(40)
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
})
