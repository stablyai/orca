import { existsSync, readFileSync } from 'node:fs'
import { writeSecureJsonFile } from './secure-file'
import type {
  GitStagedDiscardReceiptLedgerSnapshot,
  GitStagedDiscardReceiptLedgerStorage
} from './git-staged-discard-receipt-ledger'

export class GitStagedDiscardReceiptFileStorage implements GitStagedDiscardReceiptLedgerStorage {
  constructor(private readonly filePath: string) {}

  load(): unknown {
    if (!existsSync(this.filePath)) {
      return null
    }
    return JSON.parse(readFileSync(this.filePath, 'utf8'))
  }

  save(snapshot: GitStagedDiscardReceiptLedgerSnapshot): void {
    writeSecureJsonFile(this.filePath, snapshot)
  }
}
