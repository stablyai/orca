import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

type Listener = (target: RuntimeClientTarget) => void
const listeners = new Set<Listener>()
const keys = new Set([
  'codexWorkspaceAccounts',
  'claudeWorkspaceAccounts',
  'activeCodexManagedAccountId',
  'activeClaudeManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'activeClaudeManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'claudeManagedAccounts',
  'managedAccountDisplayNames'
])

export function notifyWorkspaceAccountSettingsChanged(
  target: RuntimeClientTarget,
  changedKeys?: readonly string[]
): void {
  if (changedKeys && !changedKeys.some((key) => keys.has(key))) {
    return
  }
  listeners.forEach((listener) => listener(target))
}

export function subscribeWorkspaceAccountSettingsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
