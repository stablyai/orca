// One English table for Mobile Emulator setup/attach failures: main builds the English text, the renderer translates by code.
export const EMULATOR_FAILURE_COPY = {
  disabled: 'Mobile Emulator is disabled in Settings.',
  notAvailable: 'Mobile Emulator is not available.',
  noSession: 'No emulator session is active',
  noDeviceSpecified:
    'No emulator device specified. Choose a default device in Settings > Mobile Emulator or pass a device.',
  workspaceChanged: 'The workspace changed while the emulator was starting. Reattach the emulator.',
  noIosSimulators: 'No iOS simulators found. Add one in Xcode Settings > Platforms.',
  simctlUnavailable: 'xcrun simctl is unavailable.',
  simulatorToolsUnavailable:
    'Xcode Simulator tools are unavailable. Install full Xcode, open it once, then select it with `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer`.',
  requiresMacosXcode: 'iOS Simulator requires macOS with Xcode Command Line Tools.',
  simulatorNotFound:
    'Simulator {{udid}} not found. Create one via Xcode > Window > Devices and Simulators.',
  serveSimUnavailable: 'serve-sim is unavailable.',
  serveSimNoEndpoints: 'serve-sim did not return stream endpoints.',
  serveSimEndpointUnreachable: 'serve-sim started but its stream endpoint is not reachable.',
  androidSdkMissing: 'Android SDK not found. Install Android Studio and set ANDROID_HOME.',
  adbUnavailable: 'adb is unavailable.',
  noAndroidDevices: 'No Android devices or AVDs found. Create one in Android Studio.',
  androidDeviceNotRunning: 'Android device "{{device}}" is not running. Boot it first.',
  unknownDeviceOrAvd: '"{{device}}" is not a running device or a known AVD.',
  avdBootTimeout: 'AVD "{{avdName}}" did not finish booting in time.',
  scrcpyDownloadFailed: 'Could not download scrcpy server: {{detail}}',
  scrcpyServerInvalid: 'Downloaded scrcpy server was invalid or truncated.'
} as const

export type EmulatorFailureCode = keyof typeof EMULATOR_FAILURE_COPY

export type EmulatorFailureParams = Record<string, string>

/** Wire shape for availability messages: `message` stays English for older readers. */
export type EmulatorCodedMessage = {
  message: string
  messageCode?: string
  messageParams?: EmulatorFailureParams
}

// Thrown errors reach clients as only `{ code, message }`, so match the message within its operational code.
const COPY_CODES_BY_ERROR_CODE: Readonly<Record<string, readonly EmulatorFailureCode[]>> = {
  emulator_disabled: ['disabled'],
  emulator_no_active: ['noSession', 'workspaceChanged'],
  emulator_device_not_found: [
    'noDeviceSpecified',
    'simulatorNotFound',
    'androidDeviceNotRunning',
    'unknownDeviceOrAvd'
  ],
  emulator_simctl_unavailable: ['simulatorToolsUnavailable'],
  emulator_not_macos: ['requiresMacosXcode'],
  emulator_helper_failed: [
    'serveSimNoEndpoints',
    'serveSimEndpointUnreachable',
    'avdBootTimeout',
    'scrcpyDownloadFailed',
    'scrcpyServerInvalid'
  ],
  emulator_error: ['androidSdkMissing']
}

const SLOT_PATTERN = /\{\{(\w+)\}\}/g

// One pass, so a device name containing "{{detail}}" stays verbatim.
export function emulatorFailureText(
  code: EmulatorFailureCode,
  params: EmulatorFailureParams = {}
): string {
  return EMULATOR_FAILURE_COPY[code].replace(SLOT_PATTERN, (slot, name: string) =>
    Object.hasOwn(params, name) ? params[name] : slot
  )
}

export function emulatorCodedMessage(
  code: EmulatorFailureCode,
  params?: EmulatorFailureParams
): EmulatorCodedMessage {
  return {
    message: emulatorFailureText(code, params),
    messageCode: code,
    ...(params ? { messageParams: params } : {})
  }
}

function matchTemplate(template: string, message: string): EmulatorFailureParams | null {
  const names: string[] = []
  const source = template
    .split(SLOT_PATTERN)
    .map((part, index) => {
      if (index % 2 === 0) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      names.push(part)
      return '([\\s\\S]+)'
    })
    .join('')
  const match = new RegExp(`^${source}$`).exec(message)
  if (!match) {
    return null
  }
  return Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))
}

/** Recovers the copy code of an EmulatorError from its operational code and English message. */
export function matchEmulatorErrorCopy(
  errorCode: unknown,
  message: string
): { code: EmulatorFailureCode; params: EmulatorFailureParams } | null {
  if (typeof errorCode !== 'string' || !Object.hasOwn(COPY_CODES_BY_ERROR_CODE, errorCode)) {
    return null
  }
  for (const code of COPY_CODES_BY_ERROR_CODE[errorCode]) {
    const params = matchTemplate(EMULATOR_FAILURE_COPY[code], message)
    if (params) {
      return { code, params }
    }
  }
  return null
}
