import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import {
  listWslHostWindowsPathAccess,
  type WslHostWindowsPathAccess
} from '@/lib/files/os-open/windows-path-access'
import { wslHostsAvailable } from './use-wsl-hosts-enabled'
import { routeSidebarProjectDrop } from './project-admission/drop/sidebar-project-drop'

export type WslHostOfferGate = {
  /** WSL hosts can take new work here: Windows (or its e2e fake), gate open, server files shipped. */
  gateOpen: boolean
  settingOn: boolean
  dismissed: boolean
}

/** The distro a `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…` path names; never asks WSL. */
export function wslHostOfferDistro(path: string): string | null {
  return parseWslUncPath(path)?.distro ?? null
}

export function shouldOfferWslHost(gate: WslHostOfferGate): boolean {
  return gate.gateOpen && !gate.settingOn && !gate.dismissed
}

export function readWslHostOfferGate(
  state: Pick<AppState, 'settings' | 'wslHostsAcceptNewWork' | 'wslHostServerFiles'>
): WslHostOfferGate {
  return {
    gateOpen:
      wslHostsAvailable() && state.wslHostsAcceptNewWork && state.wslHostServerFiles !== 'missing',
    settingOn: state.settings?.experimentalWslHosts === true,
    dismissed: state.settings?.wslHostOfferDismissed === true
  }
}

/** The distro to offer for `path`, or null where the add goes ahead as before. */
export function wslHostOfferFor(path: string, gate: WslHostOfferGate): string | null {
  return shouldOfferWslHost(gate) ? wslHostOfferDistro(path) : null
}

export type ExistingWslHostOffer = { hostId: ExecutionHostId; linuxPath: string; distro: string }

/** Saved WSL hosts that can take new projects: available here and the setting on. */
export function readExistingWslHosts(
  state: Pick<AppState, 'settings' | 'runtimeEnvironments'>
): WslHostWindowsPathAccess[] {
  return wslHostsAvailable()
    ? listWslHostWindowsPathAccess(
        state.runtimeEnvironments,
        state.settings?.experimentalWslHosts === true
      )
    : []
}

/** The saved host already running `path`'s distro, which a sidebar drop would add it on. */
export function existingWslHostOfferFor(
  path: string,
  hosts: readonly WslHostWindowsPathAccess[]
): ExistingWslHostOffer | null {
  // Same routing as a drop, so a `\\wsl.localhost\<distro>\mnt\c\…` folder stays on Windows.
  const route = routeSidebarProjectDrop({ path, focusedRuntimeId: null, wslHosts: hosts })
  if (route.kind !== 'wsl-host') {
    return null
  }
  const host = hosts.find((entry) => toRuntimeExecutionHostId(entry.environmentId) === route.hostId)
  return host
    ? { hostId: route.hostId, linuxPath: route.linuxPath, distro: host.access.wslDistro }
    : null
}
