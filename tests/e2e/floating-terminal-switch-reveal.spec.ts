import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Mirror FLOATING_TERMINAL_WORKTREE_ID without loading renderer/shared modules into Playwright.
const FLOATING_WORKTREE_ID = 'global-floating-terminal'
const OPEN_PANEL_SELECTOR = '[data-floating-terminal-panel][aria-hidden="false"]'

// Switching must reveal the floating panel without selecting its workspace in the main window.
test('switching to a floating terminal opens the panel and keeps the main workspace', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const mainWorktreeId = await waitForActiveWorktree(orcaPage)

  const tabId = await orcaPage.evaluate(async (worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await store.getState().updateSettings({ floatingTerminalEnabled: true })
    store.setState({ floatingWorkspacePanelOpen: false })
    return store.getState().createTab(worktreeId, undefined, undefined, { activate: false }).id
  }, FLOATING_WORKTREE_ID)
  await expect(orcaPage.locator(OPEN_PANEL_SELECTOR)).toHaveCount(0)

  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:focusTerminal', payload)
    },
    { tabId, worktreeId: FLOATING_WORKTREE_ID }
  )

  await expect(orcaPage.locator(OPEN_PANEL_SELECTOR)).toBeVisible()
  const selection = await orcaPage.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    return {
      active: state?.activeWorktreeId,
      floatingTab: state?.activeTabIdByWorktree[worktreeId]
    }
  }, FLOATING_WORKTREE_ID)
  expect(selection).toEqual({ active: mainWorktreeId, floatingTab: tabId })

  await expect(
    orcaPage.locator(`${OPEN_PANEL_SELECTOR} [data-floating-workspace-surface-frame]`)
  ).toBeVisible()
  const geometry = await orcaPage.evaluate((panelSelector) => {
    const panel = document.querySelector<HTMLElement>(panelSelector)
    const surfaceFrame = panel?.querySelector<HTMLElement>(
      '[data-floating-workspace-surface-frame]'
    )
    const handles = Array.from(
      panel?.querySelectorAll<HTMLElement>('[data-floating-terminal-no-drag]') ?? []
    )
    const eastHandle = handles.find((el) => el.classList.contains('cursor-e-resize'))
    if (!panel || !surfaceFrame || !eastHandle) {
      return null
    }
    const panelRect = panel.getBoundingClientRect()
    const surfaceRect = surfaceFrame.getBoundingClientRect()
    const eastRect = eastHandle.getBoundingClientRect()
    const outsidePanelCount = handles.filter((el) => {
      const r = el.getBoundingClientRect()
      return (
        r.left < panelRect.left - 0.5 ||
        r.right > panelRect.right + 0.5 ||
        r.top < panelRect.top - 0.5 ||
        r.bottom > panelRect.bottom + 0.5
      )
    }).length
    const scrollbarprobeX = surfaceRect.right - 3
    const scrollbarProbeY = Math.round((surfaceRect.top + surfaceRect.bottom) / 2)
    const hitAtScrollbarEdge = document.elementFromPoint(scrollbarprobeX, scrollbarProbeY)
    return {
      eastWidth: Math.round(eastRect.width),
      eastStartsAtOrAfterSurfaceRight: eastRect.left >= surfaceRect.right - 0.5,
      outsidePanelCount,
      scrollbarEdgeBlockedByResizeHandle: hitAtScrollbarEdge === eastHandle
    }
  }, OPEN_PANEL_SELECTOR)
  expect(geometry).toEqual({
    eastWidth: 4,
    eastStartsAtOrAfterSurfaceRight: true,
    outsidePanelCount: 0,
    scrollbarEdgeBlockedByResizeHandle: false
  })
})
