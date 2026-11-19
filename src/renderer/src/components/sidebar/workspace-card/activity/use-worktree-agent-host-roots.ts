import { useCallback, useMemo } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { createWorktreeAgentHostKeysSelector } from './worktree-agent-rows-projection'
import { useAppStateValueWithChannels } from '@/store/retained-views/app-state-view'

/** Roots a host-scoped card shows; the same keys while no same-ID twin's rows are mixed in. */
export function useHostRootKeys(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  roots: readonly string[]
): readonly string[] {
  const select = useMemo(
    () =>
      executionHostId ? createWorktreeAgentHostKeysSelector(worktreeId, executionHostId) : null,
    [worktreeId, executionHostId]
  )
  return useAppStateValueWithChannels(
    useCallback((s) => (select ? select(s, roots) : roots), [select, roots])
  )
}
