import type { GlobalSettings } from './global-settings-types'
import { normalizeGlobalWindowsRuntimeDefault } from './project-execution-runtime'

export type LocalAccountRuntimeTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

type LocalAccountRuntimeSettings = Pick<
  GlobalSettings,
  'localAccountRuntime' | 'localAccountWslDistro' | 'localWindowsRuntimeDefault'
>

/** Resolves the persisted account policy to a concrete host or WSL target. */
export function resolveLocalAccountRuntimeTarget(
  settings: LocalAccountRuntimeSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (settings.localAccountRuntime === 'host') {
    return { runtime: 'host', wslDistro: null }
  }
  if (settings.localAccountRuntime === 'wsl') {
    return { runtime: 'wsl', wslDistro: normalizeDistro(settings.localAccountWslDistro) }
  }

  // 'auto' (or any unset legacy value): follow the global Windows runtime default.
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  const runtimeDefault = normalizeGlobalWindowsRuntimeDefault(settings.localWindowsRuntimeDefault)
  if (runtimeDefault.kind === 'wsl') {
    return { runtime: 'wsl', wslDistro: runtimeDefault.distro }
  }
  return { runtime: 'host', wslDistro: null }
}

/** Usage pollers read the host off Windows, where a synced WSL policy has no distro to reach. */
export function resolveLocalAccountUsageTarget(
  settings: LocalAccountRuntimeSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  return platform === 'win32'
    ? resolveLocalAccountRuntimeTarget(settings, platform)
    : { runtime: 'host', wslDistro: null }
}

export function localAccountRuntimeTargetKey(target: LocalAccountRuntimeTarget): string {
  return target.runtime === 'wsl' ? `wsl:${target.wslDistro?.trim().toLowerCase() ?? ''}` : 'host'
}

function normalizeDistro(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
