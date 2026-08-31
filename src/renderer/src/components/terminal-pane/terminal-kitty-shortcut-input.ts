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
  private flags = 0
  private settled = false
  private disposed = false
  private pending: PendingKittyShortcutInput[] = []

  begin(): void {
    if (!this.disposed) {
      this.settled = false
    }
  }

  dispatch(input: TerminalKittyShortcutInput, send: (data: string) => void): boolean {
    if (this.disposed) {
      return false
    }
    if (this.settled) {
      send(this.resolve(input, this.flags))
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
    this.flags = flags
    this.settled = true
    const pending = this.pending
    this.pending = []
    for (const item of pending) {
      item.send(this.resolve(item.input, flags))
    }
  }

  settleDiscardingPending(flags: number): void {
    if (this.disposed) {
      return
    }
    this.pending = []
    this.flags = flags
    this.settled = true
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
  }

  private resolve(input: TerminalKittyShortcutInput, flags: number): string {
    return flags > 0 ? input.kitty : input.legacy
  }
}
