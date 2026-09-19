import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureSourceControlDetectedAgents,
  resolveSourceControlAgentDetectionTarget
} from '@/lib/source-control-agent-detection-target'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function useSourceControlAgentActionDetection(args: {
  worktreeId?: string | null
  connectionId?: string | null
}): {
  connectionUnavailable: boolean
  detectedAgents: TuiAgent[]
  detecting: boolean
  refreshDetectedAgents: () => Promise<TuiAgent[]>
} {
  const { worktreeId, connectionId } = args
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId ?? null)
  )
  const detectionTarget = useMemo(
    () =>
      resolveSourceControlAgentDetectionTarget({
        worktreeId,
        connectionId,
        runtimeEnvironmentId
      }),
    [connectionId, runtimeEnvironmentId, worktreeId]
  )
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detecting, setDetecting] = useState(false)
  // Why: a slower probe can finish after the target changes or a newer refresh starts.
  const detectionGenerationRef = useRef(0)
  const connectionUnavailable = detectionTarget.kind === 'unavailable'

  useEffect(() => {
    detectionGenerationRef.current += 1
    setDetectedAgents([])
    setDetecting(false)
  }, [detectionTarget])

  const refreshDetectedAgents = useCallback(async (): Promise<TuiAgent[]> => {
    const generation = ++detectionGenerationRef.current
    const isCurrent = (): boolean => generation === detectionGenerationRef.current
    if (detectionTarget.kind === 'unavailable') {
      if (isCurrent()) {
        setDetectedAgents([])
        setDetecting(false)
      }
      return []
    }
    setDetecting(true)
    try {
      const nextAgents = await ensureSourceControlDetectedAgents(
        detectionTarget,
        useAppStore.getState()
      )
      if (!isCurrent()) {
        return nextAgents
      }
      setDetectedAgents(nextAgents)
      return nextAgents
    } finally {
      if (isCurrent()) {
        setDetecting(false)
      }
    }
  }, [detectionTarget])

  return {
    connectionUnavailable,
    detectedAgents,
    detecting,
    refreshDetectedAgents
  }
}
