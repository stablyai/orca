import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import {
  buildContinuationTargetGroups,
  findContinuationTargetOption,
  type ContinuationTargetHostGroup,
  type ContinuationTargetOption
} from './continuation-target-options'
import { AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES } from '../../../../shared/ai-vault-session-handoff'
import {
  getExecutionHostDisplayLabel,
  type ExecutionHostNameSources
} from '@/lib/execution-host-display-label'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export type ContinuationTargetSelection = {
  groups: ContinuationTargetHostGroup[]
  selectedWorkspaceId: string | null
  selectedOption: ContinuationTargetOption | null
  setSelectedWorkspaceId: (workspaceId: string) => void
  hostNames: ExecutionHostNameSources
  sourceHostLabel: string
  /** Why the whole transcript cannot reach the target, or null when it can. */
  fullTranscriptBlockedReason: FullTranscriptBlockedReason
}

function toSourceConnectionId(hostId: ExecutionHostId | null | undefined): string | undefined {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? parsed.targetId : undefined
}

/** 'target-cannot-store' is a property of the host; 'too-large' is a property of the file. */
export type FullTranscriptBlockedReason = 'target-cannot-store' | 'too-large' | null

/**
 * Only a same-host path or a completed file copy puts the whole transcript where
 * the new agent can read it; everything else carries a bounded excerpt.
 */
export function resolveFullTranscriptBlockedReason(
  option: ContinuationTargetOption | null,
  sourceByteLength: number | null
): FullTranscriptBlockedReason {
  if (!option || option.bridge.kind === 'same-host') {
    return null
  }
  if (option.bridge.kind !== 'transfer') {
    return 'target-cannot-store'
  }
  return sourceByteLength !== null && sourceByteLength > AI_VAULT_HANDOFF_MAX_TRANSFER_BYTES
    ? 'too-large'
    : null
}

export function useContinuationTargetSelection(args: {
  open: boolean
  request: AgentSessionContinuationRequest | null
}): ContinuationTargetSelection {
  const worktrees = useAllWorktrees()
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [sourceByteLength, setSourceByteLength] = useState<number | null>(null)

  const hostNames = useMemo(
    () => ({ runtimeEnvironments, sshTargetLabels }),
    [runtimeEnvironments, sshTargetLabels]
  )

  const targetState = useMemo(
    () => ({ folderWorkspaces, projectGroups, repos, worktreesByRepo }),
    [folderWorkspaces, projectGroups, repos, worktreesByRepo]
  )

  const origin = args.request?.origin
  const groups = useMemo(() => {
    if (!args.request) {
      return []
    }
    return buildContinuationTargetGroups({
      state: targetState,
      worktrees,
      hostNames,
      source: {
        sessionFilePath: origin?.transcriptPath ?? args.request.source.transcriptPath,
        sessionExecutionHostId: origin?.executionHostId
      }
    })
  }, [args.request, hostNames, origin, targetState, worktrees])

  useEffect(() => {
    if (args.open && args.request) {
      setSelectedWorkspaceId(args.request.worktreeId)
    }
  }, [args.open, args.request])

  // Why: transcript size decides whether a cross-host handoff can carry the
  // whole file, and the dialog must say so before the user commits.
  useEffect(() => {
    if (!args.open || !origin?.transcriptPath) {
      setSourceByteLength(null)
      return
    }
    let cancelled = false
    void window.api.fs
      .stat({
        filePath: origin.transcriptPath,
        ...(toSourceConnectionId(origin.executionHostId)
          ? { connectionId: toSourceConnectionId(origin.executionHostId) }
          : {})
      })
      .then((stat) => {
        if (!cancelled) {
          setSourceByteLength(stat.size)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceByteLength(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [args.open, origin?.executionHostId, origin?.transcriptPath])

  const selectedOption = findContinuationTargetOption(groups, selectedWorkspaceId)

  return {
    groups,
    selectedWorkspaceId,
    selectedOption,
    setSelectedWorkspaceId,
    hostNames,
    sourceHostLabel: getExecutionHostDisplayLabel(origin?.executionHostId ?? 'local', hostNames),
    fullTranscriptBlockedReason: resolveFullTranscriptBlockedReason(
      selectedOption,
      sourceByteLength
    )
  }
}
