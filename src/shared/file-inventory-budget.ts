import { serializedQuickOpenPathBytes } from './quick-open-transport-budget'

export const FILE_INVENTORY_MAX_BYTES = 64 * 1024 * 1024
export const FILE_INVENTORY_MAX_PATH_BYTES = 64 * 1024

export class FileInventoryCapacityError extends Error {
  readonly code = 'file_inventory_capacity'
  constructor() {
    super('File inventory is too large to retain safely. Use a filtered search.')
    this.name = 'FileInventoryCapacityError'
  }
}

export class FileInventoryBudget {
  private retainedBytes = 0
  private serializedBytes = 2
  constructor(private readonly maxBytes = FILE_INVENTORY_MAX_BYTES) {}

  record(path: string): void {
    const retained = path.length * 2 + 64
    const serialized = serializedQuickOpenPathBytes(path) + 1
    if (
      Buffer.byteLength(path) > FILE_INVENTORY_MAX_PATH_BYTES ||
      this.retainedBytes + retained > this.maxBytes ||
      this.serializedBytes + serialized > this.maxBytes
    ) {
      throw new FileInventoryCapacityError()
    }
    this.retainedBytes += retained
    this.serializedBytes += serialized
  }
}
