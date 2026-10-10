import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from './app-environment'
/** Only the columns needed to verify a pane's resize signal target. */
export type NativeProcessForegroundRow = {
  pid: number
  tpgid: number
  tty: string
}

export type NativeProcessInfo = {
  /** Checks the supplied PTY device; tty is '??' when the process holds another terminal. */
  readProcessForegroundGroup(pid: number, expectedTty: string): NativeProcessForegroundRow | null
}

export const NATIVE_PROCESS_INFO_RESOURCE_PATH = join('native', 'orca-proc-info.node')
export const NATIVE_PROCESS_INFO_BUILD_PATH = join(
  'native',
  'proc-info-darwin',
  '.build',
  'release',
  'orca-proc-info.node'
)

function isNativeProcessInfo(value: unknown): value is NativeProcessInfo {
  return (
    typeof value === 'object' &&
    value !== null &&
    'readProcessForegroundGroup' in value &&
    typeof value.readProcessForegroundGroup === 'function'
  )
}

function candidatePath(): { path: string | null; definitive: boolean } {
  const resourcesPath =
    'resourcesPath' in process && typeof process.resourcesPath === 'string'
      ? process.resourcesPath
      : null
  // Packaged Electron Node-mode daemons expose resourcesPath before an app environment exists.
  if (resourcesPath && existsSync(join(resourcesPath, 'app.asar'))) {
    return { path: join(resourcesPath, NATIVE_PROCESS_INFO_RESOURCE_PATH), definitive: true }
  }
  // Development uses an explicit app root; hosts without one retain ps.
  const environment = hasAppEnvironment() ? getAppEnvironment() : null
  return {
    path:
      environment && !environment.isPackaged()
        ? join(environment.getAppPath(), NATIVE_PROCESS_INFO_BUILD_PATH)
        : null,
    definitive: environment !== null
  }
}

/** Load the addon at `path`; null when it is missing or not the expected module. */
export function loadNativeProcessInfoFrom(path: string): NativeProcessInfo | null {
  try {
    const addon = { exports: {} }
    process.dlopen(addon, path)
    return isNativeProcessInfo(addon.exports) ? addon.exports : null
  } catch {
    return null
  }
}

let cached: NativeProcessInfo | null | undefined

/** The unit-test setup disables the addon so existing subprocess mocks stay in charge. */
export const DISABLE_NATIVE_PROCESS_INFO_ENV = 'ORCA_DISABLE_NATIVE_PROCESS_INFO'

/** The trusted macOS addon, or null so resize targeting keeps its existing ps fallback. */
export function getNativeProcessInfo(): NativeProcessInfo | null {
  if (cached === undefined) {
    const enabled =
      process.platform === 'darwin' && process.env[DISABLE_NATIVE_PROCESS_INFO_ENV] !== '1'
    const candidate = enabled ? candidatePath() : { path: null, definitive: true }
    const addon =
      candidate.path && existsSync(candidate.path)
        ? loadNativeProcessInfoFrom(candidate.path)
        : null
    if (addon || candidate.definitive) {
      cached = addon
    }
  }
  return cached ?? null
}

export function setNativeProcessInfoForTests(value: NativeProcessInfo | null | undefined): void {
  cached = value
}
