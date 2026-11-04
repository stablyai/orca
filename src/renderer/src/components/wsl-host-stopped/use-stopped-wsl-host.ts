import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectStoppedWslDistro } from '@/lib/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../terminal-pane/remote-server-outage'
import { selectWslHostUnavailableReason } from '../terminal-pane/use-wsl-host-unavailable-reason'

export type StoppedWslHost = { environmentId: string; distro: string }

/** The workspace's WSL host when it is stopped and could run; a turned-off host keeps its own notice. */
export function selectStoppedWslHostEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  return selectStoppedWslDistro(state, environmentId) !== null &&
    selectWslHostUnavailableReason(state, worktreeId) === null
    ? environmentId
    : null
}

export function useStoppedWslHost(worktreeId: string | null | undefined): StoppedWslHost | null {
  const environmentId = useAppStore((state) => selectStoppedWslHostEnvironmentId(state, worktreeId))
  const distro = useAppStore((state) => selectStoppedWslDistro(state, environmentId))
  return useMemo(
    () => (environmentId && distro ? { environmentId, distro } : null),
    [environmentId, distro]
  )
}
