import {
  formatClientEnvironmentFooter,
  type ClientEnvironmentInfo
} from '../../../shared/client-environment-info'
import { getRendererAppPlatform } from './renderer-app-platform'

/** Resolve trusted desktop env details (or browser best-effort) for bug reports. */
export async function resolveClientEnvironmentInfo(): Promise<ClientEnvironmentInfo> {
  const platformInfo = resolvePlatformInfo()
  const appVersion = await resolveAppVersion()
  return {
    appVersion,
    platform: platformInfo?.platform ?? resolveFallbackPlatform(),
    osRelease: platformInfo?.osRelease ?? '',
    arch: platformInfo?.arch ?? '',
    ...(platformInfo?.shell ? { shell: platformInfo.shell } : {})
  }
}

function resolvePlatformInfo(): ReturnType<NonNullable<typeof window.api.platform>['get']> | null {
  try {
    return window.api?.platform?.get?.() ?? null
  } catch {
    return null
  }
}

function resolveFallbackPlatform(): NodeJS.Platform | 'unknown' {
  try {
    return getRendererAppPlatform()
  } catch {
    return 'unknown'
  }
}

export async function resolveClientEnvironmentFooter(): Promise<string> {
  return formatClientEnvironmentFooter(await resolveClientEnvironmentInfo())
}

async function resolveAppVersion(): Promise<string> {
  try {
    const version = await window.api?.updater?.getVersion?.()
    if (typeof version === 'string' && version.trim()) {
      return version.trim()
    }
  } catch {
    // Best-effort: feedback/error copy should still show OS details.
  }
  return 'unknown'
}
