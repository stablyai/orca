import type {
  ClaudeManagedAccountSummary,
  CodexManagedAccountSummary
} from '../../../../shared/managed-account-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { accountRuntimeScope, type NativeAccountBinding } from './ai-vault-account-binding'
import {
  SavedAccountIndex,
  accountAddress as address,
  accountEmailGroup as emailGroup,
  firstAccount as first,
  appendAccount as append,
  type SessionAccountSettings
} from './ai-vault-saved-account-index'
import {
  AccountDisplayPeers,
  emptyAccountDisplayPeers,
  resolveNativeAccountDisplay,
  type NativeAccountDisplay
} from './ai-vault-account-display'
export type { SessionAccountSettings } from './ai-vault-saved-account-index'

export class NativeAccountInputs {
  readonly claude: SavedAccountIndex
  readonly codex: SavedAccountIndex
  constructor(
    readonly settings: SessionAccountSettings | null,
    previous?: NativeAccountInputs
  ) {
    this.claude =
      previous && previous.settings?.claudeManagedAccounts === settings?.claudeManagedAccounts
        ? previous.claude
        : new SavedAccountIndex(settings, 'claude')
    this.codex =
      previous && previous.settings?.codexManagedAccounts === settings?.codexManagedAccounts
        ? previous.codex
        : new SavedAccountIndex(settings, 'codex')
  }
}

export class NativeAccountEvidence {
  readonly claudeHomes = new Map<string, ClaudeManagedAccountSummary>()
  readonly claudeCollisions = new Map<string, ClaudeManagedAccountSummary[]>()
  readonly claudeIdCollisions = new Map<string, ClaudeManagedAccountSummary[]>()
  readonly claudeIds = new Map<string, ClaudeManagedAccountSummary>()
  readonly codexCollisions = new Map<string, CodexManagedAccountSummary[]>()
  readonly codexIds = new Map<string, CodexManagedAccountSummary>()
  readonly codexGroups = new Map<string, CodexManagedAccountSummary[]>()
  readonly displayPeers = new Map<string, AccountDisplayPeers>()
  constructor(
    readonly inputs: NativeAccountInputs,
    readonly snapshot: Partial<ProviderAccountsSnapshot>
  ) {
    if (!snapshot.failedProviders?.includes('claude')) {
      for (const account of snapshot.claude?.accounts ?? []) {
        first(this.claudeIds, account.id, account)
        append(this.claudeIdCollisions, account.id, account)
        if (account.home) {
          const key = address(
            accountRuntimeScope(account.managedAuthRuntime, account.wslDistro),
            normalizeRuntimePathForComparison(account.home)
          )
          first(this.claudeHomes, key, account)
          append(this.claudeCollisions, key, account)
        }
      }
    }
    if (!snapshot.failedProviders?.includes('codex')) {
      for (const account of snapshot.codex?.accounts ?? []) {
        const scope = accountRuntimeScope(account.managedHomeRuntime, account.wslDistro)
        first(this.codexIds, address(scope, account.id), account)
        append(this.codexCollisions, address(scope, account.id), account)
        append(this.codexGroups, emailGroup(scope, account.email), account)
      }
      for (const [key, entries] of this.codexGroups) {
        this.displayPeers.set(key, new AccountDisplayPeers(entries))
      }
    }
  }
}

// Coverage compares both saved snapshots under the SAME routed-home/peer evidence.
export function sameNativeAccountDependency(
  binding: NativeAccountBinding,
  left: NativeAccountInputs,
  right: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): boolean {
  const index = left[binding.kind]
  if (index === right[binding.kind]) {
    return true
  }
  const pair = index.compare(right[binding.kind])
  const key = address(binding.scope, binding.path)
  if (!pair.same('paths', key)) {
    return false
  }
  const saved = index.paths.get(key)
  if (binding.kind === 'claude') {
    if (!pair.same('topology', binding.scope)) {
      return false
    }
    const current = evidence?.claudeHomes.get(key)
    const id = current?.id ?? saved?.id
    if (id && !pair.same('proofs', id)) {
      return false
    }
    if (
      !current &&
      saved &&
      (evidence?.claudeIdCollisions.get(saved.id)?.length ?? 0) > 1 &&
      !pair.same('orders', saved.id)
    ) {
      return false
    }
    const collisions = evidence?.claudeCollisions.get(key)
    return (
      !evidence ||
      !collisions ||
      collisions.length < 2 ||
      pair.sameEdges(evidence, key, () =>
        collisions.every((entry) => pair.same('orders', entry.id))
      )
    )
  }
  if (!saved) {
    return pair.same('topology', binding.scope)
  }
  const idKey = address(binding.scope, saved.id)
  if ((evidence?.codexCollisions.get(idKey)?.length ?? 0) > 1 && !pair.same('orders', saved.id)) {
    return false
  }
  const current = evidence?.codexIds.get(idKey)
  const currentGroup = emailGroup(binding.scope, current?.email ?? saved.email)
  if (
    evidence &&
    !pair.sameEdges(evidence, currentGroup, () =>
      (evidence.codexGroups.get(currentGroup) ?? []).every((peer) =>
        pair.same('scopedProofs', address(binding.scope, peer.id))
      )
    )
  ) {
    return false
  }
  return (
    pair.same('emailProofs', emailGroup(binding.scope, saved.email)) &&
    pair.same('emailProofs', emailGroup(binding.scope, current?.email ?? ''))
  )
}

export function nativeEvidenceCovers(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence
): boolean {
  return sameNativeAccountDependency(binding, inputs, evidence.inputs, evidence)
}

export function nativeAccountDisplay(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): NativeAccountDisplay {
  const key = address(binding.scope, binding.path)
  const saved = inputs[binding.kind].paths.get(key)
  if (binding.kind === 'claude') {
    if (!evidence?.snapshot.claude || evidence.snapshot.failedProviders?.includes('claude')) {
      return null
    }
    const current = evidence.claudeHomes.get(key)
    if (current) {
      return current.email
    }
    const summary = saved ? evidence.claudeIds.get(saved.id) : undefined
    return !summary ||
      (summary.home && normalizeRuntimePathForComparison(summary.home) !== binding.path)
      ? null
      : summary.email
  }
  if (!saved) {
    return null
  }
  const current = evidence?.codexIds.get(address(binding.scope, saved.id)) ?? saved
  const keyGroup = emailGroup(binding.scope, current.email)
  return {
    account: {
      id: current.id,
      email: current.email,
      workspaceLabel: current.workspaceLabel?.trim() || null
    },
    peers:
      (evidence?.snapshot.codex ? evidence.displayPeers : inputs.codex.displayPeers).get(
        keyGroup
      ) ?? emptyAccountDisplayPeers
  }
}

export function nativeAccountLabel(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): string | null {
  return resolveNativeAccountDisplay(nativeAccountDisplay(binding, inputs, evidence))
}
