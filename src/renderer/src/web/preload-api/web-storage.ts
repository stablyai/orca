export const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'

export const UI_STORAGE_KEY = 'orca.web.ui.v1'

export const SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'

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
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return cloneJson(fallback)
  }
  try {
    return { ...cloneJson(fallback), ...JSON.parse(raw) } as T
  } catch {
    return cloneJson(fallback)
  }
}

export function writeJson<T>(key: string, value: T): void {
  window.localStorage.setItem(key, JSON.stringify(value))
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function noopUnsubscribe(): void {}
