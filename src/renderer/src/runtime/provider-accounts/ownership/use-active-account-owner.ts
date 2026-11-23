import { useMemo } from 'react'
import { useAppStore } from '../../../store/index'
import '../../../lib/workspace/ownership/worktree-runtime-owner'
import '../../../lib/files/access/file-owner-runtime-target'
import '../../../lib/workspace/ownership/resolved-worktree-execution-host'
import {
  wslHostDistroForTarget,
  accountOwnerFor,
  type AccountOwner
} from './wsl-host-account-owner'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { visibleAccountHostId } from '@/lib/workspace/ownership/visible-account-surface'
import { runtimeRpcTargetForAuthorityKey } from '../../rpc/targets/runtime-client-target'

/** Who owns the focused workspace's provider accounts (see {@link resolveAccountOwner}). */
export function useActiveAccountOwner(fallback: RuntimeClientTarget): AccountOwner | null {
  const hostId = useAppStore(visibleAccountHostId)
  const target =
    hostId === undefined ? fallback : hostId ? runtimeRpcTargetForAuthorityKey(hostId) : null
  const ownerKey = target ? (target.kind === 'environment' ? target.environmentId : '') : null
  const ownerTarget = useMemo<RuntimeClientTarget | null>(
    () =>
      ownerKey === null
        ? null
        : ownerKey
          ? { kind: 'environment', environmentId: ownerKey }
          : { kind: 'local' },
    [ownerKey]
  )
  const wslHostDistro = useAppStore((state) =>
    ownerTarget ? wslHostDistroForTarget(ownerTarget, state.runtimeEnvironments) : null
  )
  return useMemo(
    () => (ownerTarget ? accountOwnerFor(ownerTarget, wslHostDistro) : null),
    [ownerTarget, wslHostDistro]
  )
}
