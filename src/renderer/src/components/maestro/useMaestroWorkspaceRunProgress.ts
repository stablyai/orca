import { useEffect, useState } from 'react'
import type { MaestroProjection } from '../../../../shared/maestro-projection'
import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../../shared/maestro-run-progress'
import type { RuntimeMaestroWorkspaceCanvasScope } from '../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { getMaestroProjection } from '@/runtime/runtime-maestro-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

type MaestroRunProgressResponse =
  | { schemaVersion: 2; progress: MaestroRunProgressV2 }
  | { schemaVersion: 1; progress: MaestroRunProgress }
  | { schemaVersion: null; progress: null }

const RUN_PROGRESS_POLL_INTERVAL_MS = 1_500

export function useMaestroWorkspaceRunProgress(
  target: RuntimeClientTarget,
  scope: RuntimeMaestroWorkspaceCanvasScope
): MaestroRunProgress | null {
  return useMaestroWorkspaceProjection(target, scope)?.runProgress ?? null
}

export function useMaestroWorkspaceHumanRunProgress(
  target: RuntimeClientTarget,
  scope: RuntimeMaestroWorkspaceCanvasScope
): MaestroRunProgressV2 | null {
  const executionHostId = scope.execution_host_id
  const workspaceKey = scope.workspace_key
  const identity = `${executionHostId}\0${workspaceKey}`
  const [state, setState] = useState<{
    identity: string
    progress: MaestroRunProgressV2 | null
  }>({ identity, progress: null })

  useEffect(() => {
    let active = true
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) {
        return
      }
      polling = true
      try {
        const response = await callRuntimeRpc<MaestroRunProgressResponse>(
          target,
          'maestro.runProgress.get',
          { scope: { execution_host_id: executionHostId, workspace_key: workspaceKey } }
        )
        if (active) {
          setState({
            identity,
            progress: response.schemaVersion === 2 ? response.progress : null
          })
        }
      } catch {
        // The projection-backed v1 view remains available for older or disconnected peers.
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), RUN_PROGRESS_POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [executionHostId, identity, target, workspaceKey])

  return state.identity === identity ? state.progress : null
}

export function useMaestroWorkspaceProjection(
  target: RuntimeClientTarget,
  scope: RuntimeMaestroWorkspaceCanvasScope
): MaestroProjection | null {
  const executionHostId = scope.execution_host_id
  const workspaceKey = scope.workspace_key
  const identity = `${executionHostId}\0${workspaceKey}`
  const [state, setState] = useState<{ identity: string; projection: MaestroProjection | null }>({
    identity,
    projection: null
  })
  useEffect(() => {
    let active = true
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) {
        return
      }
      polling = true
      try {
        const projection = await getMaestroProjection(target, {
          execution_host_id: executionHostId,
          workspace_key: workspaceKey
        })
        if (!active) {
          return
        }
        setState((current) =>
          current.identity === identity &&
          ((current.projection === null && projection === null) ||
            (current.projection !== null &&
              projection !== null &&
              current.projection.runId === projection.runId &&
              current.projection.revision === projection.revision))
            ? current
            : { identity, projection }
        )
      } catch {
        // Keep the last confirmed projection for this scope through transient poll failures.
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), RUN_PROGRESS_POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [executionHostId, identity, target, workspaceKey])
  return state.identity === identity ? state.projection : null
}
