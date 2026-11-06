import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectStoppedWslDistro } from '@/lib/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../terminal-pane/remote-server-outage'
import { selectWslHostEnvironmentUnavailableReason } from '../terminal-pane/use-wsl-host-unavailable-reason'

export type StoppedWslHost = { environmentId: string; distro: string }

/** A stopped distro Start can boot; a host that cannot run (turned off, server files missing) keeps its own notice. */
export function selectStartableStoppedWslDistro(
  state: Pick<
    AppState,
    'wslHostStatuses' | 'wslHostServerFiles' | 'settings' | 'runtimeEnvironments'
  >,
  environmentId: string | null | undefined
): string | null {
  const distro = selectStoppedWslDistro(state, environmentId)
  return distro !== null && selectWslHostEnvironmentUnavailableReason(state) === null
    ? distro
    : null
}

/** The workspace's WSL host when Start can boot it. */
export function selectStoppedWslHostEnvironmentId(
  state: AppState,
  worktreeId: string | null | undefined
): string | null {
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  return selectStartableStoppedWslDistro(state, environmentId) !== null ? environmentId : null
}

export function useStoppedWslHost(worktreeId: string | null | undefined): StoppedWslHost | null {
  const environmentId = useAppStore((state) => selectStoppedWslHostEnvironmentId(state, worktreeId))
  const distro = useAppStore((state) => selectStoppedWslDistro(state, environmentId))
  return useMemo(
    () => (environmentId && distro ? { environmentId, distro } : null),
    [environmentId, distro]
  )
}
