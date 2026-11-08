import type { PreloadApi } from '../../../../preload/api-types'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  getKeybindingResetBindings,
  isKeybindingActionId,
  getLegacySearchBindings,
  normalizeKeybindingArrayForAction,
  resolveKeybindingOverrides
} from '../../../../shared/keybindings'
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingFileSnapshot,
  KeybindingOverrides,
  KeybindingPlatform
} from '../../../../shared/keybindings'
import {
  isJsonObject,
  normalizeStoredWebOverrides,
  normalizeWebPlatformOverrides,
  removeConflictingWebOverrides
} from './web-keybinding-normalization'
import type { WebKeybindingDocument } from './web-keybinding-normalization'
import {
  GITHUB_CACHE_STORAGE_KEY,
  KEYBINDINGS_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  UI_STORAGE_KEY,
  getBrowserPlatform,
  readJson,
  writeJson
} from './web-storage'

export type WebKeybindingsApi = NonNullable<PreloadApi['keybindings']>

export const webKeybindingListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

const SEARCH_DEFAULTS_STORAGE_KEY = 'orca.web.searchKeybindingSeed.v1'
const NON_MAC_SEARCH_DEFAULTS_STORAGE_KEY = 'orca.web.nonMacSearchKeybindingSeed.v1'
let legacySearchDefaults = false

function migrateWebSearchKeybindings(): void {
  const storageKey =
    getWebKeybindingPlatform() === 'darwin'
      ? SEARCH_DEFAULTS_STORAGE_KEY
      : NON_MAC_SEARCH_DEFAULTS_STORAGE_KEY
  const cohort = window.localStorage.getItem(storageKey)
  if (cohort === 'done' || cohort === 'legacy') {
    legacySearchDefaults = cohort === 'legacy'
    return
  }
  legacySearchDefaults = [
    SEARCH_DEFAULTS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    KEYBINDINGS_STORAGE_KEY,
    UI_STORAGE_KEY,
    SESSION_STORAGE_KEY,
    ONBOARDING_STORAGE_KEY,
    GITHUB_CACHE_STORAGE_KEY
  ].some((key) => window.localStorage.getItem(key) !== null)
  window.localStorage.setItem(storageKey, legacySearchDefaults ? 'legacy' : 'done')
}

function getWebDefaultOverrides(): KeybindingOverrides {
  return legacySearchDefaults ? getLegacySearchBindings(getWebKeybindingPlatform()) : {}
}

export function createEmptyWebKeybindingDocument(): WebKeybindingDocument {
  return {
    version: 1,
    keybindings: {},
    platforms: {
      darwin: {},
      linux: {},
      win32: {}
    }
  }
}

export function getWebKeybindingPlatform(): KeybindingPlatform {
  return getKeybindingPlatform(getBrowserPlatform())
}

export function readWebKeybindingDocument(): WebKeybindingDocument {
  const document = readJson(KEYBINDINGS_STORAGE_KEY, createEmptyWebKeybindingDocument())
  return {
    version: 1,
    keybindings: isJsonObject(document.keybindings)
      ? (document.keybindings as KeybindingOverrides)
      : {},
    platforms: isJsonObject(document.platforms)
      ? (document.platforms as Partial<Record<KeybindingPlatform, KeybindingOverrides>>)
      : {}
  }
}

export function getWebKeybindingSnapshot(): KeybindingFileSnapshot {
  const platform = getWebKeybindingPlatform()
  const diagnostics: KeybindingFileDiagnostic[] = []
  const document = readWebKeybindingDocument()
  const commonOverrides = normalizeStoredWebOverrides(
    document.keybindings,
    'keybindings',
    diagnostics
  )
  const platformOverrides = normalizeWebPlatformOverrides(document.platforms, diagnostics)
  const overrides = removeConflictingWebOverrides(
    platform,
    resolveKeybindingOverrides(
      platform,
      { ...commonOverrides, ...platformOverrides[platform] },
      getWebDefaultOverrides()
    ),
    diagnostics
  )

  return {
    path: 'Browser local storage',
    platform,
    exists: window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY) !== null,
    overrides,
    defaultOverrides: getWebDefaultOverrides(),
    commonOverrides,
    platformOverrides,
    diagnostics
  }
}

export function writeWebKeybindingAction(
  actionId: KeybindingActionId,
  bindings: string[] | null
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${String(actionId)}".`)
  }
  const platform = getWebKeybindingPlatform()
  const currentSnapshot = getWebKeybindingSnapshot()
  const normalizedBindings =
    bindings === null
      ? getKeybindingResetBindings(actionId, platform, currentSnapshot.commonOverrides)
      : normalizeKeybindingArrayForAction(actionId, bindings)
  if (normalizedBindings !== null && !Array.isArray(normalizedBindings)) {
    throw new Error(normalizedBindings.ok ? 'Unable to parse shortcut.' : normalizedBindings.error)
  }

  const candidateOverrides = {
    ...currentSnapshot.commonOverrides,
    ...currentSnapshot.platformOverrides[platform]
  }
  if (normalizedBindings === null) {
    const common = currentSnapshot.commonOverrides[actionId]
    if (common) {
      candidateOverrides[actionId] = common
    } else {
      delete candidateOverrides[actionId]
    }
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(
    platform,
    resolveKeybindingOverrides(platform, candidateOverrides, getWebDefaultOverrides()),
    { includeMainProcessInterception: true }
  ).find((conflict) => conflict.actionIds.includes(actionId))
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with another shortcut.`
    )
  }

  const activePlatform: KeybindingOverrides = { ...currentSnapshot.platformOverrides[platform] }
  if (normalizedBindings === null) {
    delete activePlatform[actionId]
  } else {
    activePlatform[actionId] = normalizedBindings
  }

  writeJson(KEYBINDINGS_STORAGE_KEY, {
    version: 1,
    keybindings: currentSnapshot.commonOverrides,
    platforms: {
      ...currentSnapshot.platformOverrides,
      darwin: currentSnapshot.platformOverrides.darwin ?? {},
      linux: currentSnapshot.platformOverrides.linux ?? {},
      win32: currentSnapshot.platformOverrides.win32 ?? {},
      [platform]: activePlatform
    }
  } satisfies WebKeybindingDocument)

  const snapshot = getWebKeybindingSnapshot()
  notifyWebKeybindingListeners(snapshot)
  return snapshot
}

export function notifyWebKeybindingListeners(snapshot: KeybindingFileSnapshot): void {
  for (const listener of webKeybindingListeners) {
    listener(snapshot)
  }
}

export function createWebKeybindingsApi(): WebKeybindingsApi {
  try {
    migrateWebSearchKeybindings()
  } catch (error) {
    console.error('Failed to seed legacy search keybindings:', error)
  }
  return {
    get: () => Promise.resolve(getWebKeybindingSnapshot()),
    ensureFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    setAction: async ({ actionId, bindings }) => writeWebKeybindingAction(actionId, bindings),
    reload: () => {
      const snapshot = getWebKeybindingSnapshot()
      notifyWebKeybindingListeners(snapshot)
      return Promise.resolve(snapshot)
    },
    openFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    revealFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    onChanged: (callback) => {
      webKeybindingListeners.add(callback)
      const onStorage = (event: StorageEvent): void => {
        if (event.key === KEYBINDINGS_STORAGE_KEY) {
          callback(getWebKeybindingSnapshot())
        }
      }
      window.addEventListener('storage', onStorage)
      return () => {
        webKeybindingListeners.delete(callback)
        window.removeEventListener('storage', onStorage)
      }
    }
  }
}
