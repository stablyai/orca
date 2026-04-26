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

test.describe('Tab visibility with closed sidebar', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('first tab stays visible when the sidebar is collapsed', async ({ orcaPage }) => {
    // Why: the regression requires the back/forward nav group to be
    // rendered, which only happens in terminal view. The fixture already
    // leaves us there, but be explicit — a future fixture change that
    // starts in Landing/Settings would otherwise silently neuter the test.
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }
      store.getState().setActiveView('terminal')
      store.getState().setSidebarOpen(false)
    })

    const measureLayout = async (): Promise<{
      titlebarRight: number
      titlebarWidth: number
      firstTabLeft: number
      firstTabWidth: number
    } | null> =>
      orcaPage.evaluate(() => {
        const titlebarLeft = document.querySelector('.titlebar-left')
        const firstTab = document.querySelector<HTMLElement>('[data-testid="sortable-tab"]')
        if (!titlebarLeft || !firstTab) {
          return null
        }
        const tlRect = titlebarLeft.getBoundingClientRect()
        const tabRect = firstTab.getBoundingClientRect()
        return {
          titlebarRight: tlRect.right,
          titlebarWidth: tlRect.width,
          firstTabLeft: tabRect.left,
          firstTabWidth: tabRect.width
        }
      })

    // The sidebar toggle flips a state bit synchronously, but the
    // ResizeObserver that sizes `--collapsed-sidebar-header-width` fires on
    // the next frame. Poll until both elements exist and the measurement
    // has settled before asserting geometry.
    await expect
      .poll(async () => (await measureLayout()) !== null, {
        timeout: 5_000,
        message: 'Could not find floating titlebar / first tab'
      })
      .toBe(true)

    const geometry = await measureLayout()
    expect(geometry).not.toBeNull()
    const { titlebarRight, titlebarWidth, firstTabLeft, firstTabWidth } = geometry!

    // Why: if the floating titlebar is missing (width=0) or the test
    // somehow measured a tab that was clipped to 0, the geometry check
    // below would pass trivially. Assert the measurement is meaningful
    // before it guards anything.
    expect(titlebarWidth).toBeGreaterThan(0)
    expect(firstTabWidth).toBeGreaterThan(0)

    // The core invariant: the first tab must start at or past the right
    // edge of the floating titlebar. Pre-fix, the tab sat ~55px to the
    // left of this edge and was covered by the back/forward group.
    expect(firstTabLeft).toBeGreaterThanOrEqual(titlebarRight - 1)
  })
})
