import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/rpc/targets/runtime-client-target'
import { onWorkspaceCleanupRunFinished } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { CodexHistoryDiskUsage } from '../../../../../shared/workspace-cleanup/codex-history-disk-usage'

// The host walks every Codex home within a minute, then answers with a lower bound.
const DISK_USAGE_TIMEOUT_MS = 2 * 60_000

/** What the host's Codex chat history takes; null until read, or when the host can't say. */
export function useCodexHistoryDiskUsage(
  owner: RuntimeClientTarget,
  /** False while settings search hides the row: the host walks nothing for it. */
  shown: boolean
): CodexHistoryDiskUsage | null {
  const environmentId = runtimeTargetEnvironmentId(owner)
  const ownerKey = environmentId ?? 'local'
  const [state, setState] = useState<{
    ownerKey: string
    usage: CodexHistoryDiskUsage
  } | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(
    () =>
      onWorkspaceCleanupRunFinished((detail) => {
        if ((detail.environmentId ?? 'local') === ownerKey) {
          setRevision((value) => value + 1)
        }
      }),
    [ownerKey]
  )

  useEffect(() => {
    if (!shown) {
      return
    }
    let current = true
    void callRuntimeRpc<CodexHistoryDiskUsage>(
      runtimeTargetForOwnerEnvironment(environmentId),
      'workspaceCleanup.codexHistoryDiskUsage',
      undefined,
      { timeoutMs: DISK_USAGE_TIMEOUT_MS }
    ).then(
      (usage) => {
        if (current) {
          setState({ ownerKey, usage })
        }
      },
      // An older host lacks the method; a failed walk leaves the row as it was.
      () => undefined
    )
    return () => {
      current = false
    }
  }, [environmentId, ownerKey, revision, shown])

  return state?.ownerKey === ownerKey ? state.usage : null
}
