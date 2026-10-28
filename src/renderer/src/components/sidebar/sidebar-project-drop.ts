import { parseWslUncPath } from '../../../../shared/wsl-paths'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  classifyRejectedWindowsPath,
  normalizeWindowsWslPath
} from '../../../../shared/windows-path-access'
import { windowsPathOfWslDrvfsUncPath } from '../../../../shared/wsl-host-windows-drive-refusal'
import type { WslHostWindowsPathAccess } from '@/lib/windows-path-access'
import { translate } from '@/i18n/i18n'

export type SidebarProjectDropPathResolution =
  | { status: 'ready'; path: string }
  | { status: 'empty' }
  | { status: 'multiple'; count: number }

export type SidebarProjectDropAffordance =
  | { visible: false }
  | { visible: true; tone: 'ready' | 'blocked' | 'busy'; label: string; description: string }

export function resolveSidebarProjectDropPath(
  paths: readonly string[]
): SidebarProjectDropPathResolution {
  const usablePaths = paths.filter((path) => path.length > 0)
  if (usablePaths.length === 0) {
    return { status: 'empty' }
  }
  if (usablePaths.length > 1) {
    return { status: 'multiple', count: usablePaths.length }
  }
  return { status: 'ready', path: usablePaths[0] }
}

/** The focused server, which still refuses drops it cannot own; null when this computer is focused. */
export function getFocusedDropRuntimeId(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string | null {
  return settings?.activeRuntimeEnvironmentId?.trim() || null
}

export type SidebarProjectDropRoute =
  | { kind: 'local'; path: string }
  /** The dropped folder is inside a WSL host's distro: that host owns it, whatever is focused. */
  | { kind: 'wsl-host'; hostId: ExecutionHostId; linuxPath: string }
  /** D7: a Windows drive folder stays on this computer, never on the focused WSL host. */
  | { kind: 'windows-drive-on-wsl-host'; distro: string; path: string }
  | { kind: 'runtime-focused' }

export function routeSidebarProjectDrop(args: {
  path: string
  focusedRuntimeId: string | null
  wslHosts: readonly WslHostWindowsPathAccess[]
  wslRoutingEnabled?: boolean
}): SidebarProjectDropRoute {
  // Both UNC spellings enter as one; desktop admission decides the owner, never this route.
  const wslPath = args.wslRoutingEnabled ? normalizeWindowsWslPath(args.path) : null
  if (wslPath && parseWslUncPath(wslPath)) {
    return { kind: 'local', path: wslPath }
  }
  // With WSL hosts on, a distro's drive mount routes as its Windows drive path.
  const drivePath = args.wslHosts.length > 0 ? windowsPathOfWslDrvfsUncPath(args.path) : null
  if (drivePath) {
    return routeSidebarProjectDrop({ ...args, path: drivePath })
  }
  for (const host of args.wslHosts) {
    const linuxPath = host.access.fromWindows(args.path)
    if (linuxPath) {
      return { kind: 'wsl-host', hostId: toRuntimeExecutionHostId(host.environmentId), linuxPath }
    }
  }
  if (!args.focusedRuntimeId) {
    return { kind: 'local', path: args.path }
  }
  const focusedWslHost = args.wslHosts.find((host) => host.environmentId === args.focusedRuntimeId)
  return focusedWslHost && classifyRejectedWindowsPath(args.path).kind === 'windows-drive'
    ? {
        kind: 'windows-drive-on-wsl-host',
        distro: focusedWslHost.access.wslDistro,
        path: args.path
      }
    : { kind: 'runtime-focused' }
}

/** A focused server refuses drops, unless a WSL host could own the folder (a `\\wsl.localhost` drop). */
export function isSidebarProjectDropRefusedByFocus(
  focusedRuntimeId: string | null,
  wslHosts: readonly WslHostWindowsPathAccess[]
): boolean {
  return focusedRuntimeId !== null && wslHosts.length === 0
}

export function getSidebarProjectDropAffordance(args: {
  isDragOver: boolean
  isHandlingDrop: boolean
  remoteRuntimeActive: boolean
  /** A server is focused, so only a folder inside a WSL host's distro can be added. */
  wslDropsOnly?: boolean
}): SidebarProjectDropAffordance {
  if (!args.isDragOver && !args.isHandlingDrop) {
    return { visible: false }
  }
  if (args.isHandlingDrop) {
    return {
      visible: true,
      tone: 'busy',
      label: translate(
        'auto.components.sidebar.sidebar.project.drop.18d3cf40e9',
        'Checking folder'
      ),
      description: translate(
        'auto.components.sidebar.sidebar.project.drop.d0f8943f8b',
        'Preparing the project add flow'
      )
    }
  }
  if (args.remoteRuntimeActive) {
    return {
      visible: true,
      tone: 'blocked',
      label: translate(
        'auto.components.sidebar.sidebar.project.drop.e344666fb8',
        'Server runtime active'
      ),
      description: translate(
        'auto.components.sidebar.sidebar.project.drop.740e8d0d46',
        'Use Add Project for host paths'
      )
    }
  }
  if (args.wslDropsOnly) {
    return {
      visible: true,
      tone: 'ready',
      label: translate(
        'auto.components.sidebar.sidebar.project.drop.wslFolder',
        'Drop a WSL folder to add project'
      ),
      description: translate(
        'auto.components.sidebar.sidebar.project.drop.wslFolderDescription',
        'Folders under \\\\wsl.localhost'
      )
    }
  }
  return {
    visible: true,
    tone: 'ready',
    label: translate(
      'auto.components.sidebar.sidebar.project.drop.ffc769ca29',
      'Drop folder to add project'
    ),
    description: translate(
      'auto.components.sidebar.sidebar.project.drop.669e12dd97',
      'Local folders and Git repositories'
    )
  }
}
