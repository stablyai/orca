export type ComputerUsePermissionId = 'accessibility' | 'screenshots'

export type ComputerUsePermissionStatus = 'granted' | 'not-granted' | 'unsupported'

export type ComputerUsePermissionState = {
  id: ComputerUsePermissionId
  status: ComputerUsePermissionStatus
}

export type ComputerUsePermissionStatusResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  helperUnavailableReason: string | null
  permissions: ComputerUsePermissionState[]
}

export type ComputerUsePermissionSetupResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  permissionId?: ComputerUsePermissionId
  openedSettings: boolean
  // True when a helper launched, is showing for a newer request, or is queued; older clients only read this.
  launchedHelper: boolean
  // Queued for when the 5s setup window reopens; a newer request or a reset may replace it.
  launchQueued?: boolean
  permissions?: ComputerUsePermissionState[]
  nextStep?: string | null
}

export type ComputerUsePermissionResetResult = ComputerUsePermissionStatusResult & {
  bundleId: string | null
}
