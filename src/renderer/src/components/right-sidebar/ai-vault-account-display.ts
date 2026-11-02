import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import {
  getCodexAccountDisplayLabel,
  normalizeCodexAccountEmail,
  type CodexDisplayAccount
} from '@/lib/codex-account-display-label'

export class AccountDisplayPeers {
  readonly accounts: readonly CodexDisplayAccount[]
  private readonly signature: readonly string[]
  private readonly pairs = new WeakMap<AccountDisplayPeers, boolean>()

  constructor(accounts: readonly CodexDisplayAccount[]) {
    this.accounts = accounts.map((account) => ({
      id: account.id,
      email: normalizeCodexAccountEmail(account.email),
      workspaceLabel: account.workspaceLabel?.trim() || null
    }))
    this.signature = this.accounts.map((account) => JSON.stringify(account)).sort()
  }

  same(other: AccountDisplayPeers): boolean {
    if (this === other) {
      return true
    }
    let equal = this.pairs.get(other)
    if (equal === undefined) {
      equal = structuralValuesEqual(this.signature, other.signature)
      this.pairs.set(other, equal)
    }
    return equal
  }
}

export const emptyAccountDisplayPeers = new AccountDisplayPeers([])
export type NativeAccountDisplay =
  | string
  | null
  | { account: CodexDisplayAccount; peers: AccountDisplayPeers }

export function sameNativeAccountDisplay(
  a: NativeAccountDisplay,
  b: NativeAccountDisplay
): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return a === b
  }
  return (
    a.account.id === b.account.id &&
    a.account.email === b.account.email &&
    a.account.workspaceLabel === b.account.workspaceLabel &&
    a.peers.same(b.peers)
  )
}

export function resolveNativeAccountDisplay(display: NativeAccountDisplay): string | null {
  return typeof display === 'object' && display !== null
    ? getCodexAccountDisplayLabel(display.account, display.peers.accounts)
    : display
}
