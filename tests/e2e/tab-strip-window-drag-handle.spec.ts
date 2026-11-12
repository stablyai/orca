import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('a full tab strip keeps a window-drag handle while the right sidebar is closed', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)

  await orcaPage.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setSidebarOpen(false)
    state?.setRightSidebarOpen(false)
    for (let i = 0; i < 14; i++) {
      state?.createTab(id, undefined, undefined, { activate: false })
    }
  }, worktreeId)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => {
        const strip = document.querySelector('.terminal-tab-strip')
        return strip ? strip.scrollWidth > strip.clientWidth : false
      })
    )
    .toBe(true)

  // Terminal focus intentionally turns the strip no-drag until the next click (#6301).
  await orcaPage.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      active.blur()
    }
  })
  await expect(orcaPage.locator('html')).not.toHaveAttribute('data-regular-terminal-input-focused')

  const widestDragRun = await orcaPage.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[data-tab-group-strip-id]')
    if (!strip) {
      return 0
    }
    const rect = strip.getBoundingClientRect()
    const y = rect.top + rect.height / 2
    // Electron applies the nearest ancestor's app region; count only regions the strip owns,
    // not the collapsed sidebar header floating over its left edge.
    const isDraggable = (x: number): boolean => {
      for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
        const region = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
        if (region === 'drag' || region === 'no-drag') {
          return region === 'drag' && strip.contains(el)
        }
      }
      return false
    }
    let widest = 0
    let run = 0
    for (let x = Math.ceil(rect.left); x < rect.right; x++) {
      run = isDraggable(x) ? run + 1 : 0
      widest = Math.max(widest, run)
    }
    return widest
  })
  expect(widestDragRun).toBeGreaterThanOrEqual(40)
})
