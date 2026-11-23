import type { BrowserContextMenuTarget } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'

// The host reports the menu once the forwarded press reaches the page; past this the press opened none.
const RIGHT_PRESS_MENU_WAIT_MS = 3_000

export type RemoteBrowserHostContextMenuListener = (
  menu: BrowserContextMenuTarget,
  press: { clientX: number; clientY: number }
) => void

/** Pairs the page menus a host reports with this pane's own right presses; another viewer's or an agent's press opens none here. */
export class RemoteBrowserHostContextMenus {
  /** The current stream sends right presses to the page and reports the menus they open. */
  supported = false
  private press: { clientX: number; clientY: number; at: number } | null = null
  private listener: RemoteBrowserHostContextMenuListener | null = null

  setSupported(supported: boolean): void {
    this.supported = supported
    this.press = null
  }

  notePress(clientX: number, clientY: number): void {
    this.press = { clientX, clientY, at: Date.now() }
  }

  clearPress(): void {
    this.press = null
  }

  setListener(listener: RemoteBrowserHostContextMenuListener | null): void {
    this.listener = listener
  }

  deliver(menu: BrowserContextMenuTarget): void {
    const press = this.press
    if (!press || Date.now() - press.at > RIGHT_PRESS_MENU_WAIT_MS) {
      return
    }
    this.press = null
    this.listener?.(menu, press)
  }
}
