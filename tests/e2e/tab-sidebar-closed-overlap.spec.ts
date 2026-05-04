/**
 * Regression guard for the "Cmd+B collapse occludes first tab" bug fixed in
 * PR #1112. When the left sidebar is collapsed in workspace view, the
 * `.titlebar-left` header floats absolutely over the tab row. Each tab
 * group reserves a no-drag spacer under that floating header, sized from a
 * CSS variable (`--collapsed-sidebar-header-width`) measured off a ref
 * wrapper in App.tsx.
 *
 * The original regression (introduced in #1066, fixed in #1112): the ref
 * was on the *inner* control cluster (traffic-light pad + sidebar toggle +
 * agent badge), excluding the back/forward nav group that sits in the same
 * floating row. The spacer ended up ~55px narrower than the floating
 * strip, so the back/forward arrows silently covered the first tab.
 * Because the tab strip wasn't overflowing, there was no scroll affordance
 * and the covered tab was completely unreachable.
 *
 * The invariant: with terminal view active and the sidebar collapsed, the
 * first tab's left edge must clear the floating titlebar's right edge.
 * Expressing it as a geometry assertion (instead of pinning to a pixel
 * count) keeps the test stable across styling tweaks while still failing
 * loudly if any future change moves widgets in/out of the floating row
 * without updating the measured wrapper.
 */

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
    // Why: the bug title is literally "Cmd+B collapse occludes first tab",
    // so exercise the real keyboard path that App.tsx routes to
    // `actions.toggleSidebar()` at line ~620. Driving
    // `setSidebarOpen(false)` directly would silently pass a future
    // regression that broke the Cmd+B binding, carved the chord out for a
    // new editable surface, or gated the collapsed-layout CSS on a state
    // bit other than `sidebarOpen`.

    // Precondition: confirm the fixture left us in the default terminal
    // view with the sidebar open. If a future fixture change lands us in
    // Settings/Tasks or starts collapsed, the regression geometry we care
    // about (toggling open→closed, back/forward nav in the floating row)
    // isn't what gets tested.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const store = window.__store
            if (!store) {
              // Why: match helpers/store.ts — a missing store in dev means
              // the test harness is misconfigured. Throwing here keeps the
              // failure mode legible instead of timing out on toEqual.
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

    // Why: App.tsx's window-level Cmd+B handler calls `isEditableTarget`
    // (line ~582) and bails when focus is inside input/textarea/
    // contenteditable so TipTap's bold keymap can run. xterm's
    // helper-textarea is explicitly carved out of the carve-out, so the
    // fixture's default terminal-focused state is fine — but if a future
    // fixture change leaves focus on a rich input the keypress would
    // silently no-op. Blur any non-xterm focused element defensively so
    // the chord reaches the toggleSidebar branch.
    await orcaPage.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement && !active.classList.contains('xterm-helper-textarea')) {
        active.blur()
      }
    })

    await pressShortcut(orcaPage, 'b')

    // Why: Cmd+B flips `sidebarOpen` synchronously, but the React
    // re-render and the ResizeObserver that sizes
    // `--collapsed-sidebar-header-width` run on subsequent frames.
    // Waiting for `sidebarOpen === false` here doubles as a guard on the
    // keybinding itself — if Cmd+B ever stops reaching toggleSidebar,
    // this poll times out with a message that names the exact cause
    // instead of a downstream geometry failure.
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
        // Why: split tab groups render multiple sortable-tab elements, and
        // DOM order is not guaranteed to match visual order. The tab the
        // floating titlebar can occlude is the leftmost one on screen, so
        // pick by smallest bounding-rect left instead of DOM querySelector.
        const allTabs = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"]')
        )
        if (!titlebarLeft || allTabs.length === 0) {
          return null
        }
        // Why: `.titlebar-left` exists in both the sidebar-open (flex-flow)
        // and sidebar-collapsed (`position: absolute`) branches — see
        // App.tsx around line 1000. Only the collapsed branch can produce
        // the regression, so gate the measurement on the floating layout
        // actually being active. Returning null forces the poll to retry
        // until React commits the collapsed layout.
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
        // Why: the user-observable invariant is "a click on the first tab
        // hits the tab, not the floating titlebar." A pure-geometry check
        // would miss z-index / pointer-events regressions that overlay the
        // titlebar without moving the tab's rect. elementFromPoint at the
        // tab's center directly exercises reachability.
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

    // Why: the sidebar toggle flips a state bit synchronously, but the
    // ResizeObserver that sizes `--collapsed-sidebar-header-width` fires
    // on the next frame. Capture the measurement inside the poll so the
    // post-poll assertion runs against the exact frame that satisfied the
    // condition — a separate re-measurement could race and return null,
    // masking a readable failure behind a destructure TypeError.
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

    // Why: the core geometry invariant — the first tab's left edge must
    // clear the floating titlebar's right edge. Pre-fix the gap was ~55px,
    // so the -1 is sub-pixel rounding tolerance only; a real regression
    // can't hide inside one pixel.
    expect(firstTabLeft).toBeGreaterThanOrEqual(titlebarRight - 1)

    // Why: reachability check — even if geometry looks right, a z-index
    // or pointer-events regression could still overlay the titlebar on
    // top of the tab. A click at the tab's center must actually land on
    // the tab.
    expect(centerIsTabOrDescendant).toBe(true)
  })
})
