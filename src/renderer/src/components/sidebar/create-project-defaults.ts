export {
  getDefaultCreateProjectParent,
  joinCreateProjectPath
} from '../../../../shared/create-project-location'

export type GitAvailability = 'checking' | 'available' | 'unavailable' | 'unknown'

/** Use ~ only for recognized OS home layouts; suffix-matching arbitrary orca/projects paths would mislabel them. */
function isHomeProjectsFallback(pathValue: string): boolean {
  return /^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]orca[\\/]projects$/.test(
    pathValue
  )
}

export function getCreateProjectDefaultParentAutoFill({
  step,
  createParent,
  activeRuntimeEnvironmentId,
  defaultParent,
  createStepAutoFilled
}: {
  step: string
  createParent: string
  activeRuntimeEnvironmentId: string | null | undefined
  defaultParent?: string
  createStepAutoFilled: boolean
}): { parent: string } | null {
  if (step !== 'create' || createStepAutoFilled || createParent) {
    return null
  }
  if (activeRuntimeEnvironmentId?.trim()) {
    return null
  }
  const parent = defaultParent ?? ''
  if (!parent) {
    return null
  }
  return { parent }
}

export function formatCreateProjectParentSummary({
  parent,
  defaultParent,
  runtimeEnvironmentId,
  isRemoteHost,
  missingLocationLabel = 'location not selected',
  missingServerLocationLabel = 'host folder not selected'
}: {
  parent: string
  defaultParent: string
  runtimeEnvironmentId?: string | null
  isRemoteHost?: boolean
  missingLocationLabel?: string
  missingServerLocationLabel?: string
}): string {
  const trimmedParent = parent.trim()
  if (!trimmedParent) {
    return runtimeEnvironmentId || isRemoteHost ? missingServerLocationLabel : missingLocationLabel
  }
  if (
    defaultParent &&
    trimmedParent === defaultParent &&
    !runtimeEnvironmentId &&
    !isRemoteHost &&
    isHomeProjectsFallback(trimmedParent)
  ) {
    return '~/orca/projects'
  }
  return trimmedParent
}
