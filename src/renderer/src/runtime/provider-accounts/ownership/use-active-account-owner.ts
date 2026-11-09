import { useMemo } from 'react'
import { useAppStore } from '../../../store/index'
import '../../../lib/workspace/ownership/worktree-runtime-owner'
import '../../../lib/file-owner-runtime-target'
import '../../../lib/resolved-worktree-execution-host'
import '../../rpc/targets/runtime-client-target'
import {
  wslHostDistroForTarget,
  accountOwnerFor,
  type AccountOwner
} from './wsl-host-account-owner'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { useActiveWorkspaceOwnerTarget } from '../../rpc/targets/use-worktree-runtime-target'

/** Who owns the focused workspace's provider accounts (see {@link resolveAccountOwner}). */
export function useActiveAccountOwner(fallback: RuntimeClientTarget): AccountOwner {
  const ownerTarget = useActiveWorkspaceOwnerTarget(fallback)
  const wslHostDistro = useAppStore((state) =>
    wslHostDistroForTarget(ownerTarget, state.runtimeEnvironments)
  )
  return useMemo(() => accountOwnerFor(ownerTarget, wslHostDistro), [ownerTarget, wslHostDistro])
}
