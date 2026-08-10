import {
  gitStagedDiscardReceiptEntryBytes,
  type GitStagedDiscardReceiptEntry
} from './git-staged-discard-receipt-ledger-state'

export class GitStagedDiscardReceiptEntryMap extends Map<string, GitStagedDiscardReceiptEntry> {
  private readonly entryBytes = new Map<string, number>()
  private totalBytes = 0

  get bytes(): number {
    return this.totalBytes
  }

  override set(key: string, entry: GitStagedDiscardReceiptEntry): this {
    const bytes = gitStagedDiscardReceiptEntryBytes(entry)
    this.totalBytes += bytes - (this.entryBytes.get(key) ?? 0)
    this.entryBytes.set(key, bytes)
    super.set(key, entry)
    return this
  }

  override delete(key: string): boolean {
    const deleted = super.delete(key)
    if (deleted) {
      this.totalBytes -= this.entryBytes.get(key) ?? 0
      this.entryBytes.delete(key)
    }
    return deleted
  }

  override clear(): void {
    super.clear()
    this.entryBytes.clear()
    this.totalBytes = 0
  }
}
