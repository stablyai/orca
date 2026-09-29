import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getExecutionHostLabel, parseExecutionHostId } from '../../../../shared/execution-host'

type HostLabelLookups = {
  sshTargetLabels: ReadonlyMap<string, string> | undefined
  removedSshTargetLabels: ReadonlyMap<string, string> | undefined
  runtimeEnvironments: readonly { id: string; name: string }[] | undefined
}

/**
 * Readable name of the machine a session ran on, or null for this machine.
 * Why null for local: every row is local by default, so only other machines earn a badge.
 */
export function aiVaultSessionHostLabel(
  executionHostId: string | null | undefined,
  lookups: HostLabelLookups
): string | null {
  const host = parseExecutionHostId(executionHostId)
  if (!host || host.kind === 'local') {
    return null
  }
  if (host.kind === 'ssh') {
    const label =
      lookups.sshTargetLabels?.get(host.targetId) ??
      lookups.removedSshTargetLabels?.get(host.targetId)
    return label?.trim() || getExecutionHostLabel(host.id)
  }
  const environment = lookups.runtimeEnvironments?.find((env) => env.id === host.environmentId)
  return environment?.name.trim() || getExecutionHostLabel(host.id)
}

export function useAiVaultSessionHostLabel(
  executionHostId: string | null | undefined
): string | null {
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const removedSshTargetLabels = useAppStore((s) => s.removedSshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  return aiVaultSessionHostLabel(executionHostId, {
    sshTargetLabels,
    removedSshTargetLabels,
    runtimeEnvironments
  })
}

/** Names any host for display, including this machine ("Local Linux"), never an internal id. */
export function useAiVaultHostLabeler(): (executionHostId: string | null | undefined) => string {
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const removedSshTargetLabels = useAppStore((s) => s.removedSshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  return useCallback(
    (executionHostId) =>
      aiVaultSessionHostLabel(executionHostId, {
        sshTargetLabels,
        removedSshTargetLabels,
        runtimeEnvironments
      }) ?? getExecutionHostLabel(parseExecutionHostId(executionHostId)?.id ?? null),
    [sshTargetLabels, removedSshTargetLabels, runtimeEnvironments]
  )
}
