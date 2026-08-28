export type DeveloperPermissionId =
  | 'microphone'
  | 'camera'
  | 'screen'
  | 'accessibility'
  | 'full-disk-access'
  | 'automation'
  | 'local-network'
  | 'usb'
  | 'bluetooth'

export type DeveloperPermissionStatus =
  | 'granted'
  | 'denied'
  | 'not-determined'
  | 'restricted'
  | 'unknown'
  | 'unsupported'
  | 'ready'

export type DeveloperPermissionState = {
  id: DeveloperPermissionId
  status: DeveloperPermissionStatus
}

export type DeveloperPermissionRequestResult = {
  id: DeveloperPermissionId
  status: DeveloperPermissionStatus
  openedSystemSettings: boolean
}

export type LocalNetworkConnectionTestFailure =
  | 'invalid-target'
  | 'timeout'
  | 'refused'
  | 'unreachable'
  | 'unresolved'
  | 'failed'
  | 'unsupported'

export type LocalNetworkConnectionTestResult = {
  ok: boolean
  host: string
  port: number
  testedAt: number
  failure?: LocalNetworkConnectionTestFailure
}
