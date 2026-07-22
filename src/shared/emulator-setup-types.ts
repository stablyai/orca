export type XcodeApplication = {
  appPath: string
  developerDir: string
  name: string
}

export type IosSetupState =
  | 'unsupported'
  | 'xcode-missing'
  | 'xcode-selection-required'
  | 'xcode-first-launch-required'
  | 'simulator-runtime-missing'
  | 'simulator-device-missing'
  | 'ready'
  | 'error'

export type IosSetupStatus = {
  state: IosSetupState
  message: string
  selectedDeveloperDir?: string
  recommendedXcode?: XcodeApplication
  installedXcodes: XcodeApplication[]
  devices: {
    name: string
    udid: string
    state: string
    runtime: string
    isAvailable?: boolean
  }[]
}

export type AndroidSetupState =
  | 'sdk-missing'
  | 'sdk-invalid'
  | 'platform-tools-missing'
  | 'emulator-missing'
  | 'system-image-missing'
  | 'device-missing'
  | 'ready'
  | 'error'

export type AndroidSetupStatus = {
  state: AndroidSetupState
  message: string
  sdkPath?: string
  configuredPath: boolean
  studioInstalled: boolean
  studioPath?: string
  components: {
    platformTools: boolean
    emulator: boolean
    systemImages: boolean
  }
}

export type EmulatorSetupActionResult = {
  ok: boolean
  canceled?: boolean
  message?: string
}
