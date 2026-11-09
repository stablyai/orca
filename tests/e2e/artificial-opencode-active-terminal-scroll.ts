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
    // PTY flood can lose synthetic wheel delivery on Linux; scroll the viewport’s real DOM surface.
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
    // Use xterm’s public API to measure responsiveness despite lost Xvfb wheel events.
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

// Use absolute scrolling because wrapped tables outlast reliable CI wheel delivery.
export async function scrollActiveTerminalToText(page: Page, text: string): Promise<void> {
  await page.evaluate((searchText) => {
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
    const buffer = pane.terminal.buffer.active
    let targetLine: number | null = null
    for (let lineIndex = buffer.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = buffer.getLine(lineIndex)
      if (line?.translateToString(true).includes(searchText)) {
        targetLine = lineIndex
        break
      }
    }
    if (targetLine === null) {
      throw new Error(`Text not found in terminal buffer: ${searchText}`)
    }
    // Center the absolute buffer line after restore; coalesced relative events can leave wrapped rows offset.
    const centeredLine = Math.max(0, targetLine - Math.floor(pane.terminal.rows / 2))
    pane.terminal.scrollToLine(centeredLine)
    const viewport = pane.container.querySelector<HTMLElement>('.xterm-viewport')
    viewport?.dispatchEvent(new Event('scroll', { bubbles: true }))
    pane.terminal.focus()
  }, text)
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
