import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RateLimitRuntimeTarget } from '../../../../shared/rate-limit-types'
import { resolveLocalAccountRuntimeTarget } from '../../../../shared/local-account-runtime'
import { getRendererAppPlatform } from '../../lib/renderer-app-platform'

export type CodexStatusRuntimeTarget = {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
}

export type CodexStatusSwitchTarget = {
  id: string | null
  label: string
  active: boolean
  runtimeTarget: CodexStatusRuntimeTarget
}

export type CodexStatusSwitchGroup = {
  key: string
  label: string
  runtimeTarget: CodexStatusRuntimeTarget
  targets: CodexStatusSwitchTarget[]
}

export type ClaudeStatusSwitchTarget = {
  id: string | null
  label: string
  active: boolean
  runtimeTarget: CodexStatusRuntimeTarget
}

export type ClaudeStatusSwitchGroup = {
  key: string
  label: string
  runtimeTarget: CodexStatusRuntimeTarget
  targets: ClaudeStatusSwitchTarget[]
}

export type StatusSwitchGroupOptions = {
  fallbackWslDistro?: string | null
  includeFallbackWsl?: boolean
  hostLabel?: string
}

function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

export function getCodexStatusWslKey(wslDistro: string | null | undefined): string {
  const trimmed = wslDistro?.trim()
  return trimmed ? trimmed : '__default__'
}

export function getCodexStatusRuntimeLabel(
  target: CodexStatusRuntimeTarget,
  hostLabel = getHostRuntimeLabel()
): string {
  if (target.runtime === 'host') {
    return hostLabel
  }
  return target.wslDistro ? `WSL ${target.wslDistro}` : 'WSL default'
}

export function getCodexStatusRuntimeKey(target: CodexStatusRuntimeTarget): string {
  return target.runtime === 'host' ? 'host' : `wsl:${getCodexStatusWslKey(target.wslDistro)}`
}

export function toCodexStatusRuntimeTarget(
  target: RateLimitRuntimeTarget | undefined
): CodexStatusRuntimeTarget {
  if (target?.runtime === 'wsl') {
    return { runtime: 'wsl', wslDistro: target.wslDistro }
  }
  return { runtime: 'host', wslDistro: null }
}

export function getStatusBarPreferredWslDistro(
  settings: GlobalSettings | null | undefined,
  wslDistros: string[],
  platform: NodeJS.Platform = getRendererAppPlatform()
): string | null {
  if (settings) {
    const target = resolveLocalAccountRuntimeTarget(settings, platform)
    if (target.runtime === 'wsl' && target.wslDistro) {
      return target.wslDistro
    }
  }
  return wslDistros.length === 1 ? wslDistros[0] : null
}

export function shouldIncludeSettingsWslRuntime(
  settings: GlobalSettings | null | undefined
): boolean {
  if (!settings) {
    return false
  }
  // Why: the fallback group must match the concrete runtime used for account polling.
  return resolveLocalAccountRuntimeTarget(settings, getRendererAppPlatform()).runtime === 'wsl'
}
