import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { normalizeCodexAccountEmail } from '@/lib/codex-account-display-label'
import { accountRuntimeScope } from './ai-vault-account-binding'
import type { NativeAccountEvidence } from './ai-vault-native-account-index'
import { AccountDisplayPeers } from './ai-vault-account-display'

export type SessionAccountSettings = Pick<
  GlobalSettings,
  'claudeManagedAccounts' | 'codexManagedAccounts'
>
type Saved = {
  id: string
  email: string
  workspaceLabel?: string | null
  proof: string
}
export const accountAddress = (scope: string, value: string): string =>
  JSON.stringify([scope, value])
export const accountEmailGroup = (scope: string, email: string): string =>
  accountAddress(scope, normalizeCodexAccountEmail(email))
export function firstAccount<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) {
    map.set(key, value)
  }
}
export function appendAccount<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const entries = map.get(key)
  if (entries) {
    entries.push(value)
  } else {
    map.set(key, [value])
  }
}

export class SavedAccountIndex {
  readonly paths = new Map<string, Saved>()
  readonly topology = new Map<string, string[]>()
  readonly proofs = new Map<string, string[]>()
  readonly orders = new Map<string, number[]>()
  readonly scopedProofs = new Map<string, string[]>()
  readonly emailProofs = new Map<string, string[]>()
  readonly displayPeers = new Map<string, AccountDisplayPeers>()
  private readonly pairs = new WeakMap<SavedAccountIndex, SavedAccountComparison>()

  constructor(settings: SessionAccountSettings | null, kind: 'claude' | 'codex') {
    const groups = new Map<string, Saved[]>()
    for (const account of (kind === 'claude'
      ? settings?.claudeManagedAccounts
      : settings?.codexManagedAccounts) ?? []) {
      const claude = 'managedAuthPath' in account
      const scope = accountRuntimeScope(
        claude ? account.managedAuthRuntime : account.managedHomeRuntime,
        account.wslDistro
      )
      const paths = [
        claude ? account.managedAuthPath : account.managedHomePath,
        claude ? account.wslLinuxAuthPath : account.wslLinuxHomePath
      ]
        .filter((path): path is string => !!path)
        .map(normalizeRuntimePathForComparison)
      const workspaceLabel = 'workspaceLabel' in account ? account.workspaceLabel : undefined
      const saved: Saved = {
        id: account.id,
        email: account.email,
        workspaceLabel,
        proof: JSON.stringify([
          account.id,
          scope,
          paths,
          account.email,
          workspaceLabel,
          account.lastAuthenticatedAt,
          claude ? account.authMethod : account.providerAccountId,
          claude ? account.organizationUuid : account.workspaceAccountId
        ])
      }
      for (const path of paths) {
        firstAccount(this.paths, accountAddress(scope, path), saved)
      }
      appendAccount(this.topology, scope, JSON.stringify([account.id, paths]))
      appendAccount(this.proofs, account.id, saved.proof)
      appendAccount(this.orders, account.id, account.updatedAt)
      appendAccount(this.scopedProofs, accountAddress(scope, account.id), saved.proof)
      const group = accountEmailGroup(scope, account.email)
      appendAccount(this.emailProofs, group, saved.proof)
      appendAccount(groups, group, saved)
    }
    for (const entries of this.topology.values()) {
      entries.sort()
    }
    for (const entries of this.emailProofs.values()) {
      entries.sort()
    }
    for (const [key, entries] of groups) {
      this.displayPeers.set(key, new AccountDisplayPeers(entries))
    }
  }

  compare(other: SavedAccountIndex): SavedAccountComparison {
    let pair = this.pairs.get(other)
    if (!pair) {
      pair = new SavedAccountComparison(this, other)
      this.pairs.set(other, pair)
    }
    return pair
  }
}

type Slot = 'paths' | 'topology' | 'proofs' | 'orders' | 'scopedProofs' | 'emailProofs'
const emptyProofs: readonly string[] = []
export class SavedAccountComparison {
  private readonly slots = new Map<Slot, Map<string, boolean>>()
  private readonly evidence = new WeakMap<NativeAccountEvidence, Map<string, boolean>>()
  constructor(
    private readonly left: SavedAccountIndex,
    private readonly right: SavedAccountIndex
  ) {}

  same(slot: Slot, key: string): boolean {
    let results = this.slots.get(slot)
    if (!results) {
      results = new Map()
      this.slots.set(slot, results)
    }
    let equal = results.get(key)
    if (equal === undefined) {
      equal =
        slot === 'paths'
          ? structuralValuesEqual(this.left.paths.get(key)?.proof, this.right.paths.get(key)?.proof)
          : structuralValuesEqual(
              this.left[slot].get(key) ?? emptyProofs,
              this.right[slot].get(key) ?? emptyProofs
            )
      results.set(key, equal)
    }
    return equal
  }

  sameEdges(evidence: NativeAccountEvidence, key: string, compare: () => boolean): boolean {
    let results = this.evidence.get(evidence)
    if (!results) {
      results = new Map()
      this.evidence.set(evidence, results)
    }
    let equal = results.get(key)
    if (equal === undefined) {
      equal = compare()
      results.set(key, equal)
    }
    return equal
  }
}
