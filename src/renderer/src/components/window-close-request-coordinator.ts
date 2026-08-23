// Coordinates the single main->renderer window-close-request subscription (owned
// by the always-mounted App root) with the rich close-confirmation handler in
// Terminal, which only mounts once a workspace exists. Without this, quitting on
// the no-workspace landing page — where Terminal (and its listener) is not
// mounted — sends 'window:close-requested' to a renderer with no handler, so
// confirmWindowClose() is never called and the window never closes (#5144).
//
// It also runs pre-close guards: surfaces with unsaved work (e.g. the Settings
// Git AI Author prompt editors) register a guard so quitting prompts the user to
// save/discard instead of being silently vetoed by a beforeunload handler.

import { retireWindowTerminalTabsAndConfirmClose } from './terminal/terminal-window-close-retirement'
import { create } from 'zustand'

export type WindowCloseRequest = {
  isQuitting: boolean
  ownedProviderPtyIds?: string[]
}

export type WindowCloseRequestHandler = (data: WindowCloseRequest) => void

/** Returns true to allow the close to proceed, false to cancel it (e.g. the user
 *  picked "Cancel" in an unsaved-changes prompt). */
export type WindowCloseGuard = () => boolean | Promise<boolean>

let activeHandler: WindowCloseRequestHandler | null = null
const closeGuards = new Set<WindowCloseGuard>()
// Why: a guard can await a dialog; ignore re-entrant close requests (main resends
// 'window:close-requested' on each attempt) so we don't stack duplicate prompts.
let closeInFlight = false
let appQuitRequestedWhileCloseInFlight = false

type WindowCloseRunningProcessConfirmRequest = {
  settle: (confirmed: boolean) => void
}

type WindowCloseRunningProcessConfirmState = {
  windowCloseRunningProcessConfirm: WindowCloseRunningProcessConfirmRequest | null
  confirmWindowCloseRunningProcessConfirm: () => void
  cancelWindowCloseRunningProcessConfirm: () => void
}

export const useWindowCloseRunningProcessConfirmStore =
  create<WindowCloseRunningProcessConfirmState>()((set, get) => {
    const settle = (confirmed: boolean): void => {
      const request = get().windowCloseRunningProcessConfirm
      if (!request) {
        return
      }
      set({ windowCloseRunningProcessConfirm: null })
      request.settle(confirmed)
    }
    return {
      windowCloseRunningProcessConfirm: null,
      confirmWindowCloseRunningProcessConfirm: () => settle(true),
      cancelWindowCloseRunningProcessConfirm: () => settle(false)
    }
  })

function confirmWindowCloseWithRunningProcesses(): Promise<boolean> {
  return new Promise((settle) => {
    useWindowCloseRunningProcessConfirmStore.setState({
      windowCloseRunningProcessConfirm: { settle }
    })
  })
}

/** Terminal registers its rich handler while mounted; passing null on unmount
 *  hands the decision back to the App-root fallback. */
export function setWindowCloseRequestHandler(handler: WindowCloseRequestHandler | null): void {
  activeHandler = handler
}

export function getWindowCloseRequestHandler(): WindowCloseRequestHandler | null {
  return activeHandler
}

/** Register a pre-close guard. Returns an unregister function for effect cleanup. */
export function registerWindowCloseGuard(guard: WindowCloseGuard): () => void {
  closeGuards.add(guard)
  return () => {
    closeGuards.delete(guard)
  }
}

async function runWindowCloseGuards(): Promise<boolean> {
  for (const guard of closeGuards) {
    if (!(await guard())) {
      return false
    }
  }
  return true
}

/** Route a main-process close request through guards and the mounted workbench.
 *  A detached window can retain durable terminal membership after its store is
 *  empty, so its no-workbench user-close path still runs terminal retirement. */
export async function dispatchWindowCloseRequest(data: WindowCloseRequest): Promise<void> {
  if (closeInFlight) {
    if (data.isQuitting) {
      appQuitRequestedWhileCloseInFlight = true
      useWindowCloseRunningProcessConfirmStore.getState().confirmWindowCloseRunningProcessConfirm()
    }
    return
  }
  closeInFlight = true
  let request = data
  try {
    if (!(await runWindowCloseGuards())) {
      window.api.ui.cancelWindowClose()
      return
    }
    if (appQuitRequestedWhileCloseInFlight) {
      request = { isQuitting: true }
    }
    if (!request.isQuitting && request.ownedProviderPtyIds?.length) {
      const running = await Promise.allSettled(
        [...new Set(request.ownedProviderPtyIds)].map((ptyId) =>
          window.api.pty.hasChildProcesses(ptyId)
        )
      )
      if (running.some((result) => result.status === 'fulfilled' && result.value)) {
        const confirmed = await confirmWindowCloseWithRunningProcesses()
        if (appQuitRequestedWhileCloseInFlight) {
          request = { isQuitting: true }
        } else if (!confirmed) {
          window.api.ui.cancelWindowClose()
          return
        }
      }
    }
    if (activeHandler) {
      activeHandler(request)
      return
    }
    if (!request.isQuitting) {
      await retireWindowTerminalTabsAndConfirmClose(undefined, request.ownedProviderPtyIds)
      return
    }
    window.api.ui.confirmWindowClose()
  } finally {
    appQuitRequestedWhileCloseInFlight = false
    closeInFlight = false
  }
}
