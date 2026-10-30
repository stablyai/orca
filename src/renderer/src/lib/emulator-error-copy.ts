import { translate } from '@/i18n/i18n'
import {
  EMULATOR_FAILURE_COPY as EN,
  matchEmulatorErrorCopy,
  type EmulatorFailureCode
} from '../../../shared/emulator-failure-copy'

type Param = string | null

// null = required params missing; caller shows the host's English message.
const COPY: Record<EmulatorFailureCode, (params: (name: string) => Param) => string | null> = {
  disabled: () => translate('emulator.errors.disabled', EN.disabled),
  notAvailable: () => translate('emulator.errors.notAvailable', EN.notAvailable),
  noSession: () => translate('emulator.errors.noSession', EN.noSession),
  noDeviceSpecified: () => translate('emulator.errors.noDeviceSpecified', EN.noDeviceSpecified),
  workspaceChanged: () => translate('emulator.errors.workspaceChanged', EN.workspaceChanged),
  noIosSimulators: () => translate('emulator.errors.noIosSimulators', EN.noIosSimulators),
  simctlUnavailable: () => translate('emulator.errors.simctlUnavailable', EN.simctlUnavailable),
  simulatorToolsUnavailable: () =>
    translate('emulator.errors.simulatorToolsUnavailable', EN.simulatorToolsUnavailable),
  requiresMacosXcode: () => translate('emulator.errors.requiresMacosXcode', EN.requiresMacosXcode),
  simulatorNotFound: (param) => {
    const udid = param('udid')
    return udid === null
      ? null
      : translate('emulator.errors.simulatorNotFound', EN.simulatorNotFound, { udid })
  },
  serveSimUnavailable: () =>
    translate('emulator.errors.serveSimUnavailable', EN.serveSimUnavailable),
  serveSimNoEndpoints: () =>
    translate('emulator.errors.serveSimNoEndpoints', EN.serveSimNoEndpoints),
  serveSimEndpointUnreachable: () =>
    translate('emulator.errors.serveSimEndpointUnreachable', EN.serveSimEndpointUnreachable),
  androidSdkMissing: () => translate('emulator.errors.androidSdkMissing', EN.androidSdkMissing),
  adbUnavailable: () => translate('emulator.errors.adbUnavailable', EN.adbUnavailable),
  noAndroidDevices: () => translate('emulator.errors.noAndroidDevices', EN.noAndroidDevices),
  androidDeviceNotRunning: (param) => {
    const device = param('device')
    return device === null
      ? null
      : translate('emulator.errors.androidDeviceNotRunning', EN.androidDeviceNotRunning, {
          device
        })
  },
  unknownDeviceOrAvd: (param) => {
    const device = param('device')
    return device === null
      ? null
      : translate('emulator.errors.unknownDeviceOrAvd', EN.unknownDeviceOrAvd, { device })
  },
  avdBootTimeout: (param) => {
    const avdName = param('avdName')
    return avdName === null
      ? null
      : translate('emulator.errors.avdBootTimeout', EN.avdBootTimeout, { avdName })
  },
  scrcpyDownloadFailed: (param) => {
    const detail = param('detail')
    return detail === null
      ? null
      : translate('emulator.errors.scrcpyDownloadFailed', EN.scrcpyDownloadFailed, { detail })
  },
  scrcpyServerInvalid: () =>
    translate('emulator.errors.scrcpyServerInvalid', EN.scrcpyServerInvalid)
}

function isEmulatorFailureCode(code: unknown): code is EmulatorFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

function codedText(code: unknown, params: unknown): string | null {
  if (!isEmulatorFailureCode(code)) {
    return null
  }
  const values: Record<string, string> =
    typeof params === 'object' && params !== null
      ? Object.fromEntries(
          Object.entries(params).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {}
  return COPY[code]((name) => (Object.hasOwn(values, name) ? values[name] : null))
}

/** Availability text: known codes translate; unknown codes and older hosts keep the English message. */
export function emulatorMessageText(source: {
  message?: string
  messageCode?: unknown
  messageParams?: unknown
}): string {
  return codedText(source.messageCode, source.messageParams) ?? source.message ?? ''
}

/** Thrown EmulatorError text: carries only its operational code and English message over RPC. */
export function emulatorErrorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) {
    return fallback
  }
  const copy = matchEmulatorErrorCopy('code' in error ? error.code : undefined, error.message)
  return (copy && codedText(copy.code, copy.params)) ?? error.message
}
