import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import type { AiVaultSessionResumeTargetState } from './ai-vault-session-resume'

export function useAiVaultExecutionHostScope(args: {
  activeWorktreeId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
}): {
  executionHostScope: ExecutionHostScope
  activeSshExecutionHostScope: ExecutionHostScope | null
  onExecutionHostScopeChange: (scope: ExecutionHostScope) => void
} {
  const userChangedHostScopeRef = useRef(false)
  const activeExecutionHostId = useMemo(
    () => getAiVaultResumeWorkspaceExecutionHostId(args.resumeTargetState, args.activeWorktreeId),
    [args.activeWorktreeId, args.resumeTargetState]
  )
  const activeExecutionHost = parseExecutionHostId(activeExecutionHostId)
  const defaultExecutionHostScope: ExecutionHostScope =
    activeExecutionHost?.kind === 'ssh' ? activeExecutionHost.id : LOCAL_EXECUTION_HOST_ID
  const activeSshExecutionHostScope: ExecutionHostScope | null =
    activeExecutionHost?.kind === 'ssh' ? activeExecutionHost.id : null
  const [executionHostScope, setExecutionHostScope] =
    useState<ExecutionHostScope>(defaultExecutionHostScope)

  useEffect(() => {
    // Why: preserve an explicit user choice (e.g. "All") across incidental
    // rerenders, but reset to the new default once that choice no longer
    // applies to the active worktree's host.
    const allowedScopes = new Set<ExecutionHostScope>([
      LOCAL_EXECUTION_HOST_ID,
      ALL_EXECUTION_HOSTS_SCOPE,
      ...(activeSshExecutionHostScope ? [activeSshExecutionHostScope] : [])
    ])
    if (!allowedScopes.has(executionHostScope)) {
      setExecutionHostScope(defaultExecutionHostScope)
      userChangedHostScopeRef.current = false
      return
    }
    if (!userChangedHostScopeRef.current && executionHostScope !== defaultExecutionHostScope) {
      setExecutionHostScope(defaultExecutionHostScope)
    }
  }, [activeSshExecutionHostScope, defaultExecutionHostScope, executionHostScope])

  const handleExecutionHostScopeChange = useCallback(
    (nextScope: ExecutionHostScope) => {
      userChangedHostScopeRef.current = nextScope !== defaultExecutionHostScope
      setExecutionHostScope(nextScope)
    },
    [defaultExecutionHostScope]
  )

  return {
    executionHostScope,
    activeSshExecutionHostScope,
    onExecutionHostScopeChange: handleExecutionHostScopeChange
  }
}
