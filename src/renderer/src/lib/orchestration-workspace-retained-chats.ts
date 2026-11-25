import { useEffect, useEffectEvent, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHOD,
  type OrchestrationSessionWorker,
  type OrchestrationSessionWorkersResult
} from '../../../shared/orchestration-session-workers'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'

const NONE: readonly OrchestrationSessionWorker[] = []

/** The workspace's finished chat workers whose chats Orca closed, read once per mount. An older host answers nothing. */
export function useWorkspaceRetainedChats(
  target: RuntimeClientTarget,
  worktreeId: string | null
): readonly OrchestrationSessionWorker[] {
  const [read, setRead] = useState<{
    key: string
    workers: readonly OrchestrationSessionWorker[]
  } | null>(null)
  const key = worktreeId ? `${JSON.stringify(target)}\0${worktreeId}` : null
  // Read when the key changes, not when an equal target is re-created.
  const fetchWorkers = useEffectEvent((id: string) =>
    callRuntimeRpc<OrchestrationSessionWorkersResult>(
      target,
      ORCHESTRATION_WORKSPACE_RETAINED_CHATS_METHOD,
      { worktreeId: id },
      { suppressFeatureInteraction: true, background: true }
    )
  )
  useEffect(() => {
    if (!key || !worktreeId) {
      return
    }
    let current = true
    fetchWorkers(worktreeId).then(
      (result) => current && setRead({ key, workers: result.workers }),
      () => current && setRead({ key, workers: NONE })
    )
    return () => {
      current = false
    }
  }, [key, worktreeId])
  return read && read.key === key ? read.workers : NONE
}
