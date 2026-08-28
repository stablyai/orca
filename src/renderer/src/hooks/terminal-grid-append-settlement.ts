export type TerminalGridAppendSettlementIdentity = {
  transactionId: string
  tabId: string
  leafId: string
}

type PendingTerminalGridAppendRollback = TerminalGridAppendSettlementIdentity & {
  rollback: () => void
}

const MAX_SETTLED_TRANSACTIONS = 128

export class TerminalGridAppendSettlementRegistry {
  private readonly pending = new Map<string, PendingTerminalGridAppendRollback>()
  private readonly settled = new Map<
    string,
    Omit<TerminalGridAppendSettlementIdentity, 'transactionId'>
  >()

  register(entry: PendingTerminalGridAppendRollback): void {
    if (this.pending.has(entry.transactionId) || this.settled.has(entry.transactionId)) {
      throw new Error(`Terminal grid append ${entry.transactionId} is already registered`)
    }
    this.pending.set(entry.transactionId, entry)
  }

  complete(identity: TerminalGridAppendSettlementIdentity): void {
    const entry = this.requireExactPending(identity)
    this.pending.delete(identity.transactionId)
    this.rememberSettled(identity)
    void entry
  }

  rollback(identity: TerminalGridAppendSettlementIdentity): void {
    const entry = this.pending.get(identity.transactionId)
    if (!entry) {
      const settled = this.settled.get(identity.transactionId)
      if (settled?.tabId === identity.tabId && settled.leafId === identity.leafId) {
        return
      }
      throw new Error(`Terminal grid append ${identity.transactionId} is not pending`)
    }
    this.assertExactIdentity(entry, identity)
    entry.rollback()
    this.pending.delete(identity.transactionId)
    this.rememberSettled(identity)
  }

  clear(): void {
    this.pending.clear()
    this.settled.clear()
  }

  private requireExactPending(
    identity: TerminalGridAppendSettlementIdentity
  ): PendingTerminalGridAppendRollback {
    const entry = this.pending.get(identity.transactionId)
    if (!entry) {
      throw new Error(`Terminal grid append ${identity.transactionId} is not pending`)
    }
    this.assertExactIdentity(entry, identity)
    return entry
  }

  private assertExactIdentity(
    entry: PendingTerminalGridAppendRollback,
    identity: TerminalGridAppendSettlementIdentity
  ): void {
    if (entry.tabId !== identity.tabId || entry.leafId !== identity.leafId) {
      throw new Error(`Terminal grid append ${identity.transactionId} identity does not match`)
    }
  }

  private rememberSettled(identity: TerminalGridAppendSettlementIdentity): void {
    this.settled.set(identity.transactionId, {
      tabId: identity.tabId,
      leafId: identity.leafId
    })
    while (this.settled.size > MAX_SETTLED_TRANSACTIONS) {
      const oldest = this.settled.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.settled.delete(oldest)
    }
  }
}
