import type { PreloadApi } from '../../../../preload/api-types'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction,
  splitBindingsByInputKind,
  splitOverridesByInputKind,
  unionKeybindingOverrides,
  unionPlatformKeybindingOverrides
} from '../../../../shared/keybindings'
import type {
  KeybindingActionId,
  KeybindingFileDiagnostic,
  KeybindingFileSnapshot,
  KeybindingOverrides,
  KeybindingPlatform
} from '../../../../shared/keybindings'
import {
  WEB_KEYBINDING_PLATFORMS,
  isJsonObject,
  normalizeStoredWebOverrides,
  normalizeWebPlatformOverrides,
  removeConflictingWebOverrides
} from './web-keybinding-normalization'
import type { WebKeybindingDocument } from './web-keybinding-normalization'
import {
  KEYBINDINGS_STORAGE_KEY,
  MOUSE_KEYBINDINGS_STORAGE_KEY,
  getBrowserPlatform,
  readJson,
  writeJson
} from './web-storage'

export type WebKeybindingsApi = NonNullable<PreloadApi['keybindings']>

export const webKeybindingListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

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

function readStoredKeybindingDocument(storageKey: string): WebKeybindingDocument {
  const document = readJson(storageKey, createEmptyWebKeybindingDocument())
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

export function readWebKeybindingDocument(): WebKeybindingDocument {
  return readStoredKeybindingDocument(KEYBINDINGS_STORAGE_KEY)
}

/**
 * Why: this bundle can be rolled back to one that cannot parse `MouseBack`, and
 * an older bundle rewrites the keybindings document from its own parsed view —
 * erasing every binding it dropped, keyboard chords included. Mouse bindings are
 * kept under a key no older bundle reads or writes, and rejoined on read.
 */
export function readWebMouseKeybindingDocument(): WebKeybindingDocument {
  return readStoredKeybindingDocument(MOUSE_KEYBINDINGS_STORAGE_KEY)
}

export function getWebKeybindingSnapshot(): KeybindingFileSnapshot {
  const platform = getWebKeybindingPlatform()
  const diagnostics: KeybindingFileDiagnostic[] = []
  const document = readWebKeybindingDocument()
  const mouseDocument = readWebMouseKeybindingDocument()
  const commonOverrides = unionKeybindingOverrides(
    normalizeStoredWebOverrides(document.keybindings, 'keybindings', diagnostics),
    normalizeStoredWebOverrides(mouseDocument.keybindings, 'mouse.keybindings', diagnostics)
  )
  const platformOverrides = unionPlatformKeybindingOverrides(
    normalizeWebPlatformOverrides(document.platforms, diagnostics),
    normalizeWebPlatformOverrides(mouseDocument.platforms, diagnostics, 'mouse.')
  )
  const overrides = removeConflictingWebOverrides(
    platform,
    {
      ...commonOverrides,
      ...platformOverrides[platform]
    },
    diagnostics
  )

  return {
    path: 'Browser local storage',
    platform,
    exists: window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY) !== null,
    overrides,
    commonOverrides,
    platformOverrides,
    diagnostics
  }
}

function splitOtherPlatformOverrides(
  platformOverrides: Partial<Record<KeybindingPlatform, KeybindingOverrides>>,
  activePlatform: KeybindingPlatform
): {
  keyboard: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
  mouse: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
} {
  const keyboard: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  const mouse: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const platform of WEB_KEYBINDING_PLATFORMS) {
    if (platform === activePlatform) {
      continue
    }
    const split = splitOverridesByInputKind(platformOverrides[platform] ?? {})
    keyboard[platform] = split.keyboard
    if (Object.keys(split.mouse).length > 0) {
      mouse[platform] = split.mouse
    }
  }
  return { keyboard, mouse }
}

// Why: keep the key out of storage until a mouse binding exists, so the feature
// adds nothing for users who never bind one.
function writeWebMouseKeybindingDocument(document: WebKeybindingDocument): void {
  const populatedPlatforms: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const platform of WEB_KEYBINDING_PLATFORMS) {
    const overrides = document.platforms[platform]
    if (overrides && Object.keys(overrides).length > 0) {
      populatedPlatforms[platform] = overrides
    }
  }
  if (
    Object.keys(document.keybindings).length === 0 &&
    Object.keys(populatedPlatforms).length === 0
  ) {
    window.localStorage.removeItem(MOUSE_KEYBINDINGS_STORAGE_KEY)
    return
  }
  writeJson(MOUSE_KEYBINDINGS_STORAGE_KEY, {
    version: 1,
    keybindings: document.keybindings,
    platforms: populatedPlatforms
  } satisfies WebKeybindingDocument)
}

export function writeWebKeybindingAction(
  actionId: KeybindingActionId,
  bindings: string[] | null
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${String(actionId)}".`)
  }
  const normalizedBindings =
    bindings === null ? null : normalizeKeybindingArrayForAction(actionId, bindings)
  if (normalizedBindings !== null && !Array.isArray(normalizedBindings)) {
    throw new Error(normalizedBindings.ok ? 'Unable to parse shortcut.' : normalizedBindings.error)
  }

  const platform = getWebKeybindingPlatform()
  const currentSnapshot = getWebKeybindingSnapshot()
  const candidateOverrides = { ...currentSnapshot.overrides }
  if (normalizedBindings === null) {
    delete candidateOverrides[actionId]
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(platform, candidateOverrides).find((conflict) =>
    conflict.actionIds.includes(actionId)
  )
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with another shortcut.`
    )
  }

  // The snapshot is the rejoined view, so split every section before it is
  // written back — a mouse binding must never land in the keyboard document.
  const activeSplit = splitOverridesByInputKind({ ...currentSnapshot.platformOverrides[platform] })
  const commonSplit = splitOverridesByInputKind(currentSnapshot.commonOverrides)
  const editedSplit =
    normalizedBindings === null ? null : splitBindingsByInputKind(normalizedBindings)
  if (editedSplit === null) {
    delete activeSplit.keyboard[actionId]
    delete activeSplit.mouse[actionId]
  } else {
    // Written even when empty: a mouse-only action must read as "no keyboard
    // shortcut" to a bundle that cannot parse the mouse one.
    activeSplit.keyboard[actionId] = editedSplit.keyboard
    if (editedSplit.mouse.length > 0) {
      activeSplit.mouse[actionId] = editedSplit.mouse
    } else {
      delete activeSplit.mouse[actionId]
    }
  }

  const otherPlatforms = splitOtherPlatformOverrides(currentSnapshot.platformOverrides, platform)
  writeJson(KEYBINDINGS_STORAGE_KEY, {
    version: 1,
    keybindings: commonSplit.keyboard,
    platforms: {
      darwin: {},
      linux: {},
      win32: {},
      ...otherPlatforms.keyboard,
      [platform]: activeSplit.keyboard
    }
  } satisfies WebKeybindingDocument)
  writeWebMouseKeybindingDocument({
    version: 1,
    keybindings: commonSplit.mouse,
    platforms: { ...otherPlatforms.mouse, [platform]: activeSplit.mouse }
  })

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
        if (event.key === KEYBINDINGS_STORAGE_KEY || event.key === MOUSE_KEYBINDINGS_STORAGE_KEY) {
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
