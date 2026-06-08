import type { Page } from '@stablyai/playwright-test'

export type ActiveTerminalScrollState = {
  viewportY: number
  scrollTop: number | null
}

export async function scrollActiveTerminalToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = (() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    pane.terminal.scrollToBottom()
  })
}

export async function scrollActiveTerminalViewportElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = (() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    const viewport = pane.container.querySelector<HTMLElement>('.xterm-viewport')
    if (!viewport) {
      throw new Error('Active terminal viewport is unavailable')
    }
    // Why: Linux CI can drop wheel delivery entirely under PTY flood; changing
    // the viewport scrollTop exercises xterm's DOM scroll synchronization.
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 1200)
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
}

export async function scrollActiveTerminalByApi(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = (() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    // Why: Linux/Xvfb can lose synthetic wheel/DOM scroll events under flood;
    // xterm's public API keeps this probe about viewport responsiveness.
    const targetLine = Math.max(0, pane.terminal.buffer.active.viewportY - 20)
    pane.terminal.scrollToLine(targetLine)
  })
}

export async function dispatchActiveTerminalWheelEvent(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pane = (() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    // Why: CI can drop CDP wheel input while the active textarea is focused;
    // dispatching on xterm's own surfaces still exercises its user scroll path.
    const wheelTargets = [
      pane.container.querySelector<HTMLElement>('.xterm'),
      pane.container.querySelector<HTMLElement>('.xterm-viewport'),
      pane.container.querySelector<HTMLElement>('.xterm-screen')
    ].filter((target): target is HTMLElement => Boolean(target))
    if (wheelTargets.length === 0) {
      throw new Error('Active terminal wheel target is unavailable')
    }
    for (const wheelTarget of wheelTargets) {
      wheelTarget.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY: -1200
        })
      )
    }
  })
}

export async function readActiveTerminalScrollState(
  page: Page
): Promise<ActiveTerminalScrollState> {
  return page.evaluate(() => {
    const pane = (() => {
      const store = window.__store
      const state = store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      const candidate = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!candidate) {
        throw new Error('Active terminal pane is unavailable')
      }
      return candidate
    })()
    const viewport = pane.container.querySelector<HTMLElement>('.xterm-viewport')
    return {
      viewportY: pane.terminal.buffer.active.viewportY,
      scrollTop: viewport?.scrollTop ?? null
    }
  })
}
