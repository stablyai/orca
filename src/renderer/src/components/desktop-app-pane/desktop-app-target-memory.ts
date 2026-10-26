import type { DesktopAppTarget, DesktopAppWindow } from '../../../../shared/desktop-app-types'

// The chosen window per tab. Window ids do not survive an app relaunch, so a restore re-finds
// the window by app and title.
export type RememberedDesktopAppTarget = Omit<DesktopAppWindow, 'bounds'>

const STORAGE_PREFIX = 'orca.desktopAppPane.target.'

export function readRememberedTarget(tabId: string): RememberedDesktopAppTarget | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_PREFIX + tabId)
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    return isRememberedTarget(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeRememberedTarget(tabId: string, target: RememberedDesktopAppTarget): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_PREFIX + tabId, JSON.stringify(target))
  } catch {
    // Storage can be unavailable; the pane then asks for a window again on restore.
  }
}

/** The live window that best matches a remembered choice: same id, else same app and title, else same app. */
export function findRememberedWindow(
  windows: readonly DesktopAppWindow[],
  remembered: RememberedDesktopAppTarget
): DesktopAppWindow | null {
  return (
    findExactWindow(windows, remembered) ??
    windows.find((w) => w.appName === remembered.appName && w.title === remembered.title) ??
    windows.find((w) => w.appName === remembered.appName) ??
    null
  )
}

/** The listed window with exactly this pid and window id; never a look-alike. */
export function findExactWindow(
  windows: readonly DesktopAppWindow[],
  target: DesktopAppTarget
): DesktopAppWindow | null {
  return windows.find((w) => w.windowId === target.windowId && w.pid === target.pid) ?? null
}

function isRememberedTarget(value: unknown): value is RememberedDesktopAppTarget {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Record<string, unknown> = { ...value }
  return (
    typeof record.windowId === 'number' &&
    typeof record.pid === 'number' &&
    typeof record.appName === 'string' &&
    typeof record.title === 'string' &&
    (record.bundleId === null || typeof record.bundleId === 'string')
  )
}
