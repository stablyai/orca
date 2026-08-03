import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  LOCAL_EXECUTION_HOST_ID,
  getLocalExecutionHostLabel,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'

/**
 * User-facing host names keyed by execution-host id. SSH and runtime ids are
 * generated (`ssh:ssh-1754190000000-a1b2`), so any surface that renders a host
 * must resolve through this instead of falling back to `getExecutionHostLabel`.
 * Deliberately ignores connection/runtime status so label consumers don't
 * re-render on connection churn.
 */
export function useExecutionHostDisplayLabels(): ReadonlyMap<ExecutionHostId, string> {
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const settings = useAppStore((s) => s.settings)

  return useMemo(() => {
    const labels = new Map<ExecutionHostId, string>([
      [LOCAL_EXECUTION_HOST_ID, getLocalExecutionHostLabel()]
    ])
    // Why blank-guards: buildExecutionHostRegistry falls back to the id on an empty
    // name, and these labels must match the ones it feeds the sidebar's headers.
    for (const [targetId, label] of sshTargetLabels ?? []) {
      labels.set(toSshExecutionHostId(targetId), label.trim() || targetId)
    }
    for (const environment of runtimeEnvironments ?? []) {
      labels.set(
        toRuntimeExecutionHostId(environment.id),
        environment.name.trim() || environment.id
      )
    }
    // Why: per-host renames are the user's last word over the derived name.
    for (const [hostId, label] of getHostDisplayLabelOverrides(settings)) {
      labels.set(hostId, label)
    }
    return labels
  }, [runtimeEnvironments, settings, sshTargetLabels])
}
