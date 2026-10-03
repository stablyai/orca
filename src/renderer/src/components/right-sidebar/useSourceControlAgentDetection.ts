import { useCallback, useState } from 'react'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'

type DetectionOptions = Pick<SourceControlAgentActionDialogProps, 'connectionId' | 'worktreeId'>

type DetectionResult = {
  connectionUnavailable: boolean
  detectedAgents: TuiAgent[]
  detecting: boolean
  refreshDetectedAgents: () => Promise<TuiAgent[]>
}

export function useSourceControlAgentDetection({
  connectionId,
  worktreeId
}: DetectionOptions): DetectionResult {
  const ensureDetectedAgents = useAppStore((state) => state.ensureDetectedAgents)
  const ensureRemoteDetectedAgents = useAppStore((state) => state.ensureRemoteDetectedAgents)
  const ensureRuntimeDetectedAgents = useAppStore((state) => state.ensureRuntimeDetectedAgents)
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  )
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detecting, setDetecting] = useState(false)
  const connectionUnavailable = Boolean(
    worktreeId && connectionId === undefined && !runtimeEnvironmentId
  )

  const refreshDetectedAgents = useCallback(async (): Promise<TuiAgent[]> => {
    if (connectionUnavailable) {
      setDetectedAgents([])
      setDetecting(false)
      return []
    }
    setDetecting(true)
    try {
      const nextAgents =
        typeof connectionId === 'string'
          ? await ensureRemoteDetectedAgents(connectionId)
          : runtimeEnvironmentId
            ? await ensureRuntimeDetectedAgents(runtimeEnvironmentId)
            : await ensureDetectedAgents(worktreeId)
      setDetectedAgents(nextAgents)
      return nextAgents
    } finally {
      setDetecting(false)
    }
  }, [
    connectionId,
    connectionUnavailable,
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents,
    runtimeEnvironmentId,
    worktreeId
  ])

  return { connectionUnavailable, detectedAgents, detecting, refreshDetectedAgents }
}
