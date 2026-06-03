import type { GlobalSettings } from '../../../../shared/types'

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

export function isRemoteRuntimeActive(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): boolean {
  return Boolean(settings?.activeRuntimeEnvironmentId?.trim())
}

export function getSidebarProjectDropAffordance(args: {
  isDragOver: boolean
  isHandlingDrop: boolean
  remoteRuntimeActive: boolean
}): SidebarProjectDropAffordance {
  if (!args.isDragOver && !args.isHandlingDrop) {
    return { visible: false }
  }
  if (args.isHandlingDrop) {
    return {
      visible: true,
      tone: 'busy',
      label: 'Checking folder',
      description: 'Preparing the project add flow'
    }
  }
  if (args.remoteRuntimeActive) {
    return {
      visible: true,
      tone: 'blocked',
      label: 'Server runtime active',
      description: 'Use Add Project for server paths'
    }
  }
  return {
    visible: true,
    tone: 'ready',
    label: 'Drop folder to add project',
    description: 'Local folders and Git repositories'
  }
}
