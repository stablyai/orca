import { getLegacySearchBindings } from './definitions'
import { getEffectiveKeybindingsForAction } from './effective'
import { findKeybindingConflicts } from './formatting'
import { getKeybindingConflictIdentity } from './matching-key'
import { resolveKeybindingOverrides } from './profile-defaults'
import type {
  KeybindingActionId,
  KeybindingFileSnapshot,
  KeybindingOverrides,
  SearchShortcutChoice
} from './types'

const SEARCH_ACTION: KeybindingActionId = 'worktree.palette'
const SEARCH_BINDING = 'Mod+K'

/** An active plugin command's chord owner; resolveKeybindingOverrides only knows core definitions. */
export type SearchShortcutPluginOwner = {
  actionId: KeybindingActionId
  title: string
  defaultBindings: readonly string[]
}

export type SearchShortcutOwner = { actionId: KeybindingActionId; title?: string }

export type SearchShortcutOffer =
  | { kind: 'eligible' }
  // Later edits may win over an accepted choice; report what Search actually got.
  | { kind: 'accepted'; searchOnModK: boolean; owners: SearchShortcutOwner[] }
  | { kind: 'custom-search' }
  | { kind: 'conflict'; owners: SearchShortcutOwner[] }
  // Explicit choices aren't authoritative (unreadable file or failed legacy import), so preflight can't run.
  | { kind: 'file-error' }
  // New profiles, and legacy profiles whose Search already has Mod+K.
  | { kind: 'none' }

export function parseSearchShortcutChoice(value: unknown): SearchShortcutChoice | null {
  return value === 'accepted' || value === 'dismissed' ? value : null
}

/** Opted-in legacy profiles get the new-profile Search key while keeping the legacy chord; clear falls back to unbound. */
export function getSearchOptInBindings(platform: NodeJS.Platform): KeybindingOverrides {
  return {
    [SEARCH_ACTION]: [SEARCH_BINDING, ...(getLegacySearchBindings(platform)[SEARCH_ACTION] ?? [])]
  }
}

export function getLegacyProfileSearchDefaults(
  platform: NodeJS.Platform,
  choice: SearchShortcutChoice | null
): KeybindingOverrides {
  return choice === 'accepted'
    ? getSearchOptInBindings(platform)
    : getLegacySearchBindings(platform)
}

export function getExplicitKeybindingOverrides(
  snapshot: Pick<KeybindingFileSnapshot, 'commonOverrides' | 'platformOverrides' | 'platform'>,
  fallbackOverrides: KeybindingOverrides = {}
): KeybindingOverrides {
  return {
    ...fallbackOverrides,
    ...snapshot.commonOverrides,
    ...snapshot.platformOverrides[snapshot.platform]
  }
}

/** Snapshot-level preflight; refuses when the shared file is unreadable. */
export function planSearchShortcutOptInForSnapshot(
  snapshot: KeybindingFileSnapshot,
  pluginOwners: readonly SearchShortcutPluginOwner[] = []
): SearchShortcutOffer {
  if (!snapshot.searchShortcut) {
    return { kind: 'none' }
  }
  if (
    snapshot.searchShortcut.fileError ||
    snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'readFailed')
  ) {
    // Explicit state is unknown; an accepted choice is still live and undoable.
    return snapshot.searchShortcut.choice === 'accepted'
      ? { kind: 'accepted', searchOnModK: true, owners: [] }
      : { kind: 'file-error' }
  }
  return planSearchShortcutOptIn(
    snapshot.platform,
    getExplicitKeybindingOverrides(snapshot),
    snapshot.searchShortcut.choice,
    pluginOwners
  )
}

function searchHasModK(platform: NodeJS.Platform, overrides: KeybindingOverrides): boolean {
  const identity = getKeybindingConflictIdentity(SEARCH_BINDING, platform)
  return getEffectiveKeybindingsForAction(SEARCH_ACTION, platform, overrides).some(
    (binding) => getKeybindingConflictIdentity(binding, platform) === identity
  )
}

function findModKOwners(
  platform: NodeJS.Platform,
  explicitOverrides: KeybindingOverrides,
  searchOnModK: boolean,
  pluginOwners: readonly SearchShortcutPluginOwner[]
): SearchShortcutOwner[] {
  const identity = getKeybindingConflictIdentity(SEARCH_BINDING, platform)
  const owners: SearchShortcutOwner[] = []
  if (!searchOnModK) {
    const coreOwners = new Set<KeybindingActionId>()
    for (const conflict of findKeybindingConflicts(
      platform,
      { ...explicitOverrides, [SEARCH_ACTION]: [SEARCH_BINDING] },
      { includeMainProcessInterception: true }
    )) {
      if (conflict.actionIds.includes(SEARCH_ACTION)) {
        for (const actionId of conflict.actionIds) {
          if (actionId !== SEARCH_ACTION) {
            coreOwners.add(actionId)
          }
        }
      }
    }
    owners.push(...[...coreOwners].map((actionId) => ({ actionId })))
  }
  for (const plugin of pluginOwners) {
    // An explicit override replaces a plugin command's manifest keys, as at dispatch.
    const bindings = Object.hasOwn(explicitOverrides, plugin.actionId)
      ? (explicitOverrides[plugin.actionId] ?? [])
      : plugin.defaultBindings
    if (bindings.some((binding) => getKeybindingConflictIdentity(binding, platform) === identity)) {
      owners.push({ actionId: plugin.actionId, title: plugin.title })
    }
  }
  return owners
}

/** Preflight for a legacy-cohort profile; only an `eligible` result may be persisted. */
export function planSearchShortcutOptIn(
  platform: NodeJS.Platform,
  explicitOverrides: KeybindingOverrides,
  choice: SearchShortcutChoice | null,
  pluginOwners: readonly SearchShortcutPluginOwner[] = []
): SearchShortcutOffer {
  const optedIn = (): boolean =>
    searchHasModK(
      platform,
      resolveKeybindingOverrides(platform, explicitOverrides, getSearchOptInBindings(platform))
    )
  if (choice === 'accepted') {
    const searchOnModK = optedIn()
    return {
      kind: 'accepted',
      searchOnModK,
      owners: findModKOwners(platform, explicitOverrides, searchOnModK, pluginOwners)
    }
  }
  const legacy = resolveKeybindingOverrides(
    platform,
    explicitOverrides,
    getLegacySearchBindings(platform)
  )
  if (searchHasModK(platform, legacy)) {
    return { kind: 'none' }
  }
  if (Object.hasOwn(explicitOverrides, SEARCH_ACTION)) {
    return { kind: 'custom-search' }
  }
  const searchOnModK = optedIn()
  const owners = findModKOwners(platform, explicitOverrides, searchOnModK, pluginOwners)
  return owners.length > 0 || !searchOnModK ? { kind: 'conflict', owners } : { kind: 'eligible' }
}

/** True when an accepted choice actually gave Search Mod+K with no other owner. */
export function searchShortcutOptInIsEffective(offer: SearchShortcutOffer): boolean {
  return offer.kind === 'accepted' && offer.searchOnModK && offer.owners.length === 0
}
