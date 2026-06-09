import type { GlobalSettings } from '../../../../shared/types'
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
        'Use Add Project for server paths'
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
