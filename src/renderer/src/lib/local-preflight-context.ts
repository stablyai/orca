import type { AppState } from '@/store/types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { getProviderRuntimeContextKey } from './provider-runtime-context'

export type LocalPreflightContext =
  | { wslDistro?: string | null; wslDefault?: boolean; runtimeContextKey?: string }
  | undefined

const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()
const wslDefaultPreflightContext = Object.freeze({ wslDefault: true })

export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
}

function getWslPreflightContext(wslDistro: string): NonNullable<LocalPreflightContext> {
  const cached = wslPreflightContextsByDistro.get(wslDistro)
  if (cached) {
    return cached
  }

  // Why: React/Zustand selectors must return a cached snapshot. A fresh object
  // here triggers a useSyncExternalStore loop when Settings observes WSL repos.
  const context = Object.freeze({ wslDistro })
  wslPreflightContextsByDistro.set(wslDistro, context)
  return context
}

export function getLocalPreflightContext(state: AppState): LocalPreflightContext {
  if (state.settings?.activeRuntimeEnvironmentId?.trim()) {
    return { runtimeContextKey: getProviderRuntimeContextKey(state.settings) }
  }
  const wslDistro = getLocalPreflightWslDistro(state)
  return wslDistro ? getWslPreflightContext(wslDistro) : undefined
}

export function getLocalAgentPreflightContext(state: AppState): LocalPreflightContext {
  const explicitAgentRuntime = state.settings?.localAgentRuntime
  if (explicitAgentRuntime === 'host') {
    return undefined
  }
  if (explicitAgentRuntime === 'wsl') {
    const explicitDistro =
      state.settings?.localAgentWslDistro?.trim() ||
      state.settings?.terminalWindowsWslDistro?.trim()
    if (explicitDistro) {
      return getWslPreflightContext(explicitDistro)
    }
    return wslDefaultPreflightContext
  }

  const wslDistro = getLocalPreflightWslDistro(state)
  if (wslDistro) {
    return getWslPreflightContext(wslDistro)
  }
  if (state.settings?.terminalWindowsShell === 'wsl.exe') {
    const preferredDistro = state.settings.terminalWindowsWslDistro?.trim()
    if (preferredDistro) {
      return getWslPreflightContext(preferredDistro)
    }
    return wslDefaultPreflightContext
  }
  return undefined
}

function getLocalPreflightWslDistro(state: AppState): string | null {
  const activeWorktree = state.activeWorktreeId
    ? Object.values(state.worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === state.activeWorktreeId)
    : null
  const activePath =
    activeWorktree?.path ?? (state.repos ?? []).find((repo) => repo.id === state.activeRepoId)?.path
  return getWslDistroFromPath(activePath)
}

export function localPreflightContextKey(context: LocalPreflightContext): string {
  if (context?.runtimeContextKey) {
    return context.runtimeContextKey
  }
  if (context?.wslDistro) {
    return `wsl:${context.wslDistro}`
  }
  return context?.wslDefault ? 'wsl:default' : 'host'
}
