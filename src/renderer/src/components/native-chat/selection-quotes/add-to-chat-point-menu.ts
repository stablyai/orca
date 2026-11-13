// Which Add to chat target list is open at a screen point; kept apart from the menu so editors
// can open it without loading the menu's components.
import type { LaunchSource } from '../../../../../shared/telemetry-property-schemas'

export type AddToChatSource = { worktreeId: string; quote: string; launchSource: LaunchSource }

type PointMenu = AddToChatSource & { x: number; y: number }
export type OpenPointMenu = PointMenu & { returnFocus: HTMLElement | null; cancelled: boolean }

let pointMenu: OpenPointMenu | null = null
const listeners = new Set<() => void>()

export function setPointMenu(next: OpenPointMenu | null): void {
  pointMenu = next
  listeners.forEach((listener) => listener())
}

export function readPointMenu(): OpenPointMenu | null {
  return pointMenu
}

export function subscribePointMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Opens the target list at a screen point, for surfaces with no menu of their own to nest it in. */
export function openAddToChatMenuAt(menu: PointMenu): void {
  const focused = document.activeElement
  setPointMenu({
    ...menu,
    returnFocus: focused instanceof HTMLElement && focused !== document.body ? focused : null,
    cancelled: false
  })
}
