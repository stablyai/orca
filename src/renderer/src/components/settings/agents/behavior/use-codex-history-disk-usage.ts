import { useEffect, useState, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/rpc/targets/runtime-client-target'
import { onWorkspaceCleanupRunFinished } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import {
  getWindowParkVisible,
  subscribeWindowParkVisibility
} from '@/lib/window-activity/window-park-visibility'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { CodexHistoryDiskUsage } from '../../../../../../shared/workspace-cleanup/codex-history-disk-usage'

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
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  // `revision` counts cleanup runs that may have freed history; each is read at most once.
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{
    ownerKey: string
    revision: number
    usage: CodexHistoryDiskUsage | null
  } | null>(null)
  const readRevision = state?.ownerKey === ownerKey ? state.revision : null

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
    // A hidden window or row waits; it reads once when shown if a run finished meanwhile.
    if (!shown || !windowVisible || readRevision === revision) {
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
          setState({ ownerKey, revision, usage })
        }
      },
      // An older host lacks the method; a failed walk shows no line.
      () => {
        if (current) {
          setState({ ownerKey, revision, usage: null })
        }
      }
    )
    return () => {
      current = false
    }
  }, [environmentId, ownerKey, revision, readRevision, shown, windowVisible])

  return state?.ownerKey === ownerKey ? state.usage : null
}
