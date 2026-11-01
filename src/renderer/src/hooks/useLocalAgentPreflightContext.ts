import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { createLocalAgentPreflightSelector } from '@/lib/local-agent-preflight-selector'

export function useLocalAgentPreflightContext(worktreeId?: string | null, enabled = true) {
  const select = useMemo(
    () => (enabled ? createLocalAgentPreflightSelector(worktreeId) : () => undefined),
    [worktreeId, enabled]
  )
  return useAppStore(select)
}
