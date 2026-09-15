type TransferOperations = {
  import: () => Promise<void>
  isDestinationLive: () => boolean
  remove: () => boolean | Promise<boolean>
  rollback: () => void | Promise<void>
}

export class WorkspaceViewTransfer {
  private readonly transactions = new Set<string>()

  async run(id: string, operations: TransferOperations): Promise<boolean> {
    if (this.transactions.has(id)) {
      return false
    }
    this.transactions.add(id)
    let removing = false
    try {
      await operations.import()
      if (operations.isDestinationLive()) {
        removing = true
        if (await operations.remove()) {
          return true
        }
        removing = false
      }
    } catch {
      if (removing) {
        return false
      }
    }
    await operations.rollback()
    return false
  }
}
