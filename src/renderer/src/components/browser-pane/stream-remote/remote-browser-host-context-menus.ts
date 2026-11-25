import type { BrowserContextMenuTarget } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'

// The host reports the menu right after the forwarded press reaches the page; past this it opened none.
const RIGHT_PRESS_MENU_WAIT_MS = 3_000

// `sentAt` stays null while the press waits behind earlier input in the queue.
export type RemoteBrowserHostMenuPress = { clientX: number; clientY: number; sentAt: number | null }

export type RemoteBrowserHostContextMenuListener = (
  menu: BrowserContextMenuTarget,
  press: { clientX: number; clientY: number }
) => void

/** Pairs the page menus a host reports with this pane's own right presses; another viewer's or an agent's press opens none here. */
export class RemoteBrowserHostContextMenus {
  /** The current stream sends right presses to the page and reports the menus they open. */
  supported = false
  private press: RemoteBrowserHostMenuPress | null = null
  private listener: RemoteBrowserHostContextMenuListener | null = null

  setSupported(supported: boolean): void {
    this.supported = supported
    this.press = null
  }

  notePress(clientX: number, clientY: number): RemoteBrowserHostMenuPress {
    this.press = { clientX, clientY, sentAt: null }
    return this.press
  }

  /** The press or its release is going to the host now; the menu it opens follows shortly. */
  markPressSent(press: RemoteBrowserHostMenuPress): void {
    // A newer press replaced this one; its own dispatch stamps it.
    if (this.press === press) {
      press.sentAt = Date.now()
    }
  }

  /** A press whose menu may still come; one the page cancelled stops counting once the wait ends. */
  get hasPendingPress(): boolean {
    const press = this.press
    return press !== null && (press.sentAt === null || !this.waitEnded(press.sentAt))
  }

  clearPress(): void {
    this.press = null
  }

  setListener(listener: RemoteBrowserHostContextMenuListener | null): void {
    this.listener = listener
  }

  deliver(menu: BrowserContextMenuTarget): void {
    const press = this.press
    if (!press || press.sentAt === null || this.waitEnded(press.sentAt)) {
      return
    }
    this.press = null
    this.listener?.(menu, press)
  }

  private waitEnded(sentAt: number): boolean {
    return Date.now() - sentAt > RIGHT_PRESS_MENU_WAIT_MS
  }
}
