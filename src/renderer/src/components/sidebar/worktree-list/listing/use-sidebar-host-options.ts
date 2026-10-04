import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import { buildSidebarHostOptions, type SidebarHostOption } from '../../sidebar-host-options'

const EMPTY_SSH_TARGET_LABELS: ReadonlyMap<string, string> = new Map()

/** Store-backed host options, memoized on exactly the inputs the registry reads. */
export function useSidebarHostOptions(): SidebarHostOption[] {
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  // Why the fallback: lightweight test stores mock only the slices they exercise.
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels ?? EMPTY_SSH_TARGET_LABELS)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const hostLabelOverrides = useMemo(() => getHostDisplayLabelOverrides(settings), [settings])
  return useMemo(
    () =>
      buildSidebarHostOptions({
        repos,
        sshTargetLabels,
        sshConnectionStates,
        settings,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId,
        hostLabelOverrides
      }),
    [
      repos,
      sshTargetLabels,
      sshConnectionStates,
      settings,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides
    ]
  )
}

export function useSidebarHostLabelById(): ReadonlyMap<string, string> {
  const hostOptions = useSidebarHostOptions()
  return useMemo(() => new Map(hostOptions.map((host) => [host.id, host.label])), [hostOptions])
}
