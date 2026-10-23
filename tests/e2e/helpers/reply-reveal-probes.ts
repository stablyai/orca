/**
 * Main-process probes for the reply-reveal E2E. They record the two outcomes a completion can have
 * without anything reaching the desktop: the native banner (show() is captured, never displayed) and
 * the reveal's IPC to the renderer. A windowless launch already turns the window reveal itself into a
 * no-op, so the renderer IPC is the observable proof that main chose to bring the tab forward.
 */
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import type { NotificationDispatchResult } from '../../../src/shared/notification-settings-types'
import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

export type ReplyRevealProbeLog = {
  dispatches: { paneKey?: string; result: NotificationDispatchResult }[]
  banners: { at: number; title: string; body: string }[]
  reveals: {
    at: number
    channel: string
    tabId?: string
    worktreeId?: string
    paneKey?: string
  }[]
}

type ReplyRevealProbeState = ReplyRevealProbeLog & { focused: boolean; clockOffsetMs: number }

declare global {
  var __replyRevealProbe: ReplyRevealProbeState | undefined
}

export async function installReplyRevealProbes(app: ElectronApplication): Promise<void> {
  await retryTransientMainEvaluate(() =>
    app.evaluate(({ BrowserWindow, Notification, ipcMain }) => {
      if (globalThis.__replyRevealProbe) {
        return
      }
      const probe: ReplyRevealProbeState = {
        banners: [],
        reveals: [],
        dispatches: [],
        focused: false,
        clockOffsetMs: 0
      }
      const now = Date.now
      Date.now = () => now() + probe.clockOffsetMs
      globalThis.__replyRevealProbe = probe
      // Why: a captured show() keeps the banner request observable without posting a real
      // notification to the developer's desktop.
      Notification.prototype.show = function show(this: Notification) {
        probe.banners.push({ at: Date.now(), title: this.title, body: this.body })
      }
      const text = (detail: unknown, key: string): string | undefined => {
        const value =
          typeof detail === 'object' && detail !== null && key in detail
            ? Reflect.get(detail, key)
            : undefined
        return typeof value === 'string' ? value : undefined
      }
      const registry: unknown = Reflect.get(ipcMain, '_invokeHandlers')
      const dispatch: unknown =
        registry instanceof Map ? registry.get('notifications:dispatch') : null
      if (typeof dispatch !== 'function') {
        throw new Error('notifications:dispatch handler missing')
      }
      ipcMain.removeHandler('notifications:dispatch')
      ipcMain.handle('notifications:dispatch', async (event, request) => {
        const result: NotificationDispatchResult = await dispatch(event, request)
        probe.dispatches.push({ paneKey: text(request, 'paneKey'), result })
        return result
      })
      for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents
        const send = contents.send.bind(contents)
        contents.send = (channel: string, ...args: unknown[]) => {
          if (
            channel === 'ui:focusTerminal' ||
            channel === 'ui:focusEditorTab' ||
            channel === 'ui:activateWorktree'
          ) {
            probe.reveals.push({
              at: Date.now(),
              channel,
              tabId: text(args[0], 'tabId'),
              worktreeId: text(args[0], 'worktreeId'),
              paneKey: text(args[0], 'ackPaneKeyOnSuccess')
            })
          }
          send(channel, ...args)
        }
        // Why: headless windows are never focused; S2 needs main to see a focused Orca.
        const isFocused = window.isFocused.bind(window)
        window.isFocused = () => probe.focused || isFocused()
      }
    })
  )
}

export async function advanceReplyRevealClock(
  app: ElectronApplication,
  milliseconds: number
): Promise<number> {
  return app.evaluate((_electron, value) => {
    const probe = globalThis.__replyRevealProbe
    if (!probe) {
      throw new Error('reply reveal probes missing')
    }
    probe.clockOffsetMs += value
    return Date.now()
  }, milliseconds)
}

export async function setProbeWindowFocused(
  app: ElectronApplication,
  focused: boolean
): Promise<void> {
  await app.evaluate((_electron, value) => {
    const probe = globalThis.__replyRevealProbe
    if (probe) {
      probe.focused = value
    }
  }, focused)
}

export async function readReplyRevealProbe(app: ElectronApplication): Promise<ReplyRevealProbeLog> {
  return app.evaluate(() => {
    const probe = globalThis.__replyRevealProbe
    return {
      banners: [...(probe?.banners ?? [])],
      reveals: [...(probe?.reveals ?? [])],
      dispatches: [...(probe?.dispatches ?? [])]
    }
  })
}

export async function setBringToFront(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async (value) => {
    const state = window.__store!.getState()
    await state.updateSettings({
      notifications: { ...state.settings!.notifications, bringToFrontOnAgentTaskComplete: value }
    })
  }, enabled)
}

/** Opens a new terminal tab in the active worktree and returns its id once its PTY is live. */
export async function createTerminalTab(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const tab = state.createTab(worktreeId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', worktreeId)
    return tab.id
  })
}

export async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store!.getState()
    const worktreeId = Object.entries(state.tabsByWorktree).find(([, tabs]) =>
      tabs.some((tab) => tab.id === id)
    )?.[0]
    if (!worktreeId) {
      throw new Error(`Tab ${id} has no workspace`)
    }
    if (state.activeWorktreeId !== worktreeId) {
      state.setActiveWorktree(worktreeId)
    }
    window.__store!.getState().setActiveTab(id)
    window.__store!.getState().setActiveTabType('terminal', worktreeId)
  }, tabId)
}

export async function readActiveView(
  page: Page
): Promise<{ worktreeId: string | null; tabId: string | null }> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return { worktreeId: state.activeWorktreeId, tabId: state.activeTabId }
  })
}
