export const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'

import {
  WORKSPACE_WINDOW_UI_STORAGE_KEY,
  WORKSPACE_WINDOW_SESSION_STORAGE_KEY,
  isWorkspaceWindowPresentationKey
} from '../../../../shared/workspace-window-presentation-storage'

export const UI_STORAGE_KEY = WORKSPACE_WINDOW_UI_STORAGE_KEY

export const SESSION_STORAGE_KEY = WORKSPACE_WINDOW_SESSION_STORAGE_KEY

export const ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'

export const GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'

export const KEYBINDINGS_STORAGE_KEY = 'orca.web.keybindings.v1'

export function getBrowserPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'linux'
  }
  return 'darwin'
}

export function readJson<T>(key: string, fallback: T): T {
  const storage = isWorkspaceWindowPresentationKey(key)
    ? window.orcaWorkspaceWindowNative?.presentationStorage
    : undefined
  const nativeRaw = storage?.getItem(key)
  const raw = window.localStorage.getItem(key)
  if (!raw && !nativeRaw) {
    return cloneJson(fallback)
  }
  try {
    return {
      ...cloneJson(fallback),
      ...(raw ? JSON.parse(raw) : {}),
      ...(nativeRaw ? JSON.parse(nativeRaw) : {})
    } as T
  } catch {
    return cloneJson(fallback)
  }
}

export function writeJson<T>(key: string, value: T): void {
  const raw = JSON.stringify(value)
  if (isWorkspaceWindowPresentationKey(key)) {
    window.orcaWorkspaceWindowNative?.presentationStorage?.setItem(key, raw)
  }
  window.localStorage.setItem(key, raw)
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function noopUnsubscribe(): void {}
