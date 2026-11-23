import type { BrowserContextMenuTarget } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'

// The host reports the menu right after the forwarded press reaches the page; past this it opened none.
const RIGHT_PRESS_MENU_WAIT_MS = 3_000

export type RemoteBrowserHostContextMenuListener = (
  menu: BrowserContextMenuTarget,
  press: { clientX: number; clientY: number }
) => void

/** Pairs the page menus a host reports with this pane's own right presses; another viewer's or an agent's press opens none here. */
export class RemoteBrowserHostContextMenus {
  /** The current stream sends right presses to the page and reports the menus they open. */
  supported = false
  // `sentAt` stays null while the press waits behind earlier input in the queue.
  private press: { clientX: number; clientY: number; sentAt: number | null } | null = null
  private listener: RemoteBrowserHostContextMenuListener | null = null

  setSupported(supported: boolean): void {
    this.supported = supported
    this.press = null
  }

  notePress(clientX: number, clientY: number): void {
    this.press = { clientX, clientY, sentAt: null }
  }

  /** The press or its release is going to the host now; the menu it opens follows shortly. */
  markPressSent(): void {
    if (this.press) {
      this.press.sentAt = Date.now()
    }
  }

  get hasPendingPress(): boolean {
    return this.press !== null
  }

  clearPress(): void {
    this.press = null
  }

  setListener(listener: RemoteBrowserHostContextMenuListener | null): void {
    this.listener = listener
  }

  deliver(menu: BrowserContextMenuTarget): void {
    const press = this.press
    if (!press || press.sentAt === null || Date.now() - press.sentAt > RIGHT_PRESS_MENU_WAIT_MS) {
      return
    }
    this.press = null
    this.listener?.(menu, press)
  }
}
