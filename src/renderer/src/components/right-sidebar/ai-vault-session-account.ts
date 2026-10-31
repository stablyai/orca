import { useMemo, useSyncExternalStore } from 'react'
import type { ManagedDataAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import {
  sessionAccountBinding,
  type SessionAccountSource,
  type AccountBinding
} from './ai-vault-account-binding'
import { readSessionAccount, subscribeSessionAccount } from './ai-vault-account-directory'
import {
  NativeAccountInputs,
  NativeAccountEvidence,
  nativeAccountLabel,
  type SessionAccountSettings
} from './ai-vault-native-account-index'

type SessionAccounts = Partial<ProviderAccountsSnapshot> & { opencode?: ManagedDataAccountsState }

export function resolveAiVaultSessionAccount(
  session: SessionAccountSource,
  settings: SessionAccountSettings | null,
  accounts: SessionAccounts | null
): string | null {
  const selected = sessionAccountBinding(session)
  if ('value' in selected) {
    return selected.value
  }
  const { binding } = selected
  if (binding.kind === 'opencode') {
    return accounts?.opencode?.accounts.find((account) => account.id === binding.id)?.label ?? null
  }
  const inputs = new NativeAccountInputs(settings)
  return nativeAccountLabel(
    binding,
    inputs,
    accounts ? new NativeAccountEvidence(inputs, accounts) : null
  )
}

export function useAiVaultSessionAccount(session: SessionAccountSource): string | null {
  const selected = sessionAccountBinding(session)
  const key = 'key' in selected ? selected.key : null
  const staticValue = 'value' in selected ? selected.value : null
  const kind = 'binding' in selected ? selected.binding.kind : null
  const profileId =
    'binding' in selected && selected.binding.kind === 'opencode' ? selected.binding.id : null
  const path =
    'binding' in selected && selected.binding.kind !== 'opencode' ? selected.binding.path : null
  const scope =
    'binding' in selected && selected.binding.kind !== 'opencode' ? selected.binding.scope : null
  const observation = useMemo(() => {
    const binding: AccountBinding | null =
      kind === 'opencode' && profileId !== null
        ? { kind, id: profileId }
        : (kind === 'claude' || kind === 'codex') && path !== null && scope !== null
          ? { kind, path, scope }
          : null
    return {
      subscribe: (listener: () => void) =>
        key !== null && binding ? subscribeSessionAccount(key, binding, listener) : () => {},
      read: () => (key === null ? staticValue : readSessionAccount(key))
    }
  }, [key, staticValue, kind, profileId, path, scope])
  return useSyncExternalStore(observation.subscribe, observation.read, observation.read)
}
