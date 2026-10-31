import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useLocalAgentPreflightContext } from '@/hooks/useLocalAgentPreflightContext'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'

/**
 * A local agent list refused while its WSL distro was stopped stays failed. The user opening a
 * launch picker is a user act, so it retries that list once as a wake (E9). Any other failure,
 * native or WSL, is left to the normal retry so an open picker never loops probes.
 */
export function useAgentPickerRefusedWake(
  userOpened: boolean,
  detectionTarget: AgentDetectionTarget | undefined
): void {
  const worktreeId =
    userOpened && detectionTarget?.kind === 'local'
      ? (detectionTarget.worktreeId ?? null)
      : undefined
  const context = useLocalAgentPreflightContext(worktreeId, worktreeId !== undefined)
  const key = worktreeId !== undefined ? localAgentInventoryContextKey(context) : undefined
  // The target this open already woke; cleared on close so the next open may wake again.
  const wokenFor = useRef<{ worktreeId: string | null } | null>(null)
  const failed = useAppStore(
    (state) => key !== undefined && state.readLocalAgentInventoryByKey(key).state === 'failed'
  )
  useEffect(() => {
    if (worktreeId === undefined) {
      wokenFor.current = null
      return
    }
    if (!failed || wokenFor.current?.worktreeId === worktreeId) {
      return
    }
    const state = useAppStore.getState()
    if (!state.isLocalAgentInventoryRefused(worktreeId)) {
      return
    }
    wokenFor.current = { worktreeId }
    void state.ensureDetectedAgentsForPicker(worktreeId)
  }, [failed, worktreeId])
}
