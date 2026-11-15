import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useMemo } from 'react'
import type { AppState } from '@/store/types'
import {
  selectConnectingWslDistro,
  selectStoppedWslDistro
} from '@/runtime/hosts/wsl/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../../lib/workspace/ownership/workspace-runtime-environment'
import { selectWslHostEnvironmentUnavailableReason } from '../../runtime/hosts/wsl/wsl-host-availability'

export type StoppedWslHost = { environmentId: string; distro: string }
/** A host a read surface waits on instead of showing its read error; `connecting` once Start (or a reconnect) is under way. */
export type WslHostReadOutage = StoppedWslHost & { connecting: boolean }

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
  const environmentId = useAppStateValue((state) =>
    selectStoppedWslHostEnvironmentId(state, worktreeId)
  )
  const distro = useAppStateValue((state) => selectStoppedWslDistro(state, environmentId))
  return useMemo(
    () => (environmentId && distro ? { environmentId, distro } : null),
    [environmentId, distro]
  )
}

/**
 * For surfaces that mask a read error: a read that failed while the host was down stays stale
 * until the host answers, so a connecting host keeps the notice up instead of that error.
 */
export function useWslHostReadOutage(
  worktreeId: string | null | undefined
): WslHostReadOutage | null {
  const stopped = useStoppedWslHost(worktreeId)
  const environmentId = useAppStateValue((state) =>
    selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  )
  const connectingDistro = useAppStateValue((state) =>
    selectConnectingWslDistro(state, environmentId)
  )
  return useMemo(() => {
    if (stopped) {
      return { ...stopped, connecting: false }
    }
    return environmentId && connectingDistro
      ? { environmentId, distro: connectingDistro, connecting: true }
      : null
  }, [stopped, environmentId, connectingDistro])
}
