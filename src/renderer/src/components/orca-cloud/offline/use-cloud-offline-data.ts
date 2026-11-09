import { useCallback, useEffect, useRef, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type {
  CloudOfflineSnapshot,
  CloudQueuedPrompt
} from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'

const ASLEEP_POLL_MS = 15_000

/**
 * The asleep view's data: the client-side cached copy and the prompts queued to it. Reads only
 * while `enabled` (the workspace may be asleep); answers for another workspace are dropped, so a
 * worktree switch can never show the previous workspace's copy.
 */
export function useCloudOfflineData(
  workspaceId: string,
  enabled: boolean
): {
  snapshot: CloudOfflineSnapshot | null
  queued: CloudQueuedPrompt[]
  refresh: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<CloudOfflineSnapshot | null>(null)
  const [queued, setQueued] = useState<CloudQueuedPrompt[]>([])
  const current = useRef(workspaceId)
  current.current = workspaceId

  const refresh = useCallback(async () => {
    const api = window.api?.orcaCloudOffline
    if (!api) {
      return
    }
    const asked = workspaceId
    const [next, prompts] = await Promise.all([
      api.getSnapshot({ workspaceId: asked }),
      api.listQueuedPrompts({ workspaceId: asked })
    ])
    if (current.current !== asked) {
      return
    }
    setSnapshot(next && next.workspaceId === asked ? next : null)
    setQueued(prompts.filter((prompt) => prompt.workspaceId === asked))
  }, [workspaceId])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void refresh()
    const offQueue = window.api?.orcaCloudOffline?.onQueuedPromptsChanged((event) => {
      if (event.workspaceId === workspaceId) {
        void refresh()
      }
    })
    const stop = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: ASLEEP_POLL_MS,
      slowWhileUnfocused: true
    })
    return () => {
      offQueue?.()
      stop()
    }
  }, [enabled, workspaceId, refresh])

  return { snapshot: enabled ? snapshot : null, queued, refresh }
}
