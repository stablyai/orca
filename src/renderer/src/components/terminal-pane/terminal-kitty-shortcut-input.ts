export type TerminalKittyShortcutInput = {
  kitty: string
  legacy: string
}

const MAX_PENDING_KITTY_SHORTCUT_INPUTS = 32

type PendingKittyShortcutInput = {
  input: TerminalKittyShortcutInput
  send: (data: string) => void
}

export class TerminalKittyShortcutInputSettlement {
  private settled = false
  private disposed = false
  private pending: PendingKittyShortcutInput[] = []

  begin(): void {
    if (!this.disposed) {
      this.settled = false
    }
  }

  dispatch(
    input: TerminalKittyShortcutInput,
    currentFlags: number,
    send: (data: string) => void
  ): boolean {
    if (this.disposed) {
      return false
    }
    if (this.settled) {
      send(this.resolve(input, currentFlags))
      return true
    }
    if (this.pending.length < MAX_PENDING_KITTY_SHORTCUT_INPUTS) {
      this.pending.push({ input, send })
    }
    return true
  }

  settle(flags: number): void {
    if (this.disposed) {
      return
    }
    this.settled = true
    const pending = this.pending
    this.pending = []
    for (const item of pending) {
      item.send(this.resolve(item.input, flags))
    }
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
  }

  private resolve(input: TerminalKittyShortcutInput, flags: number): string {
    return flags > 0 ? input.kitty : input.legacy
  }
}
