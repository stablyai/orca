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
  // keepsLegacyKey: an explicit binding may already hold the legacy chord, so copy must not promise it.
  | { kind: 'eligible'; keepsLegacyKey: boolean }
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

/** Snapshot-level plan. An accepted choice is judged by the live effective bindings, which main routing uses too. */
export function planSearchShortcutOptInForSnapshot(
  snapshot: KeybindingFileSnapshot,
  pluginOwners: readonly SearchShortcutPluginOwner[] = []
): SearchShortcutOffer {
  if (!snapshot.searchShortcut) {
    return { kind: 'none' }
  }
  if (snapshot.searchShortcut.choice === 'accepted') {
    // Effective overrides already carry explicit, fallback and inherited bindings, readable file or not.
    const searchOnModK = searchHasModK(snapshot.platform, snapshot.overrides)
    return {
      kind: 'accepted',
      searchOnModK,
      owners: findModKOwners(snapshot.platform, snapshot.overrides, pluginOwners)
    }
  }
  if (
    snapshot.searchShortcut.fileError ||
    snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'readFailed')
  ) {
    return { kind: 'file-error' }
  }
  return planSearchShortcutOptIn(
    snapshot.platform,
    getExplicitKeybindingOverrides(snapshot),
    pluginOwners
  )
}

function searchHasModK(platform: NodeJS.Platform, overrides: KeybindingOverrides): boolean {
  return searchHasBinding(platform, overrides, SEARCH_BINDING)
}

function searchHasBinding(
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides,
  binding: string
): boolean {
  const identity = getKeybindingConflictIdentity(binding, platform)
  return getEffectiveKeybindingsForAction(SEARCH_ACTION, platform, overrides).some(
    (candidate) => getKeybindingConflictIdentity(candidate, platform) === identity
  )
}

function findModKOwners(
  platform: NodeJS.Platform,
  explicitOverrides: KeybindingOverrides,
  pluginOwners: readonly SearchShortcutPluginOwner[]
): SearchShortcutOwner[] {
  const identity = getKeybindingConflictIdentity(SEARCH_BINDING, platform)
  const owners: SearchShortcutOwner[] = []
  // Enumerate even when Search already has Mod+K: a hand-edited file can give it to both.
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

/** Preflight for an undecided or dismissed legacy-cohort profile; only `eligible` may be persisted. */
function planSearchShortcutOptIn(
  platform: NodeJS.Platform,
  explicitOverrides: KeybindingOverrides,
  pluginOwners: readonly SearchShortcutPluginOwner[]
): SearchShortcutOffer {
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
  const optedIn = resolveKeybindingOverrides(
    platform,
    explicitOverrides,
    getSearchOptInBindings(platform)
  )
  const searchOnModK = searchHasModK(platform, optedIn)
  const owners = findModKOwners(platform, explicitOverrides, pluginOwners)
  if (owners.length > 0 || !searchOnModK) {
    return { kind: 'conflict', owners }
  }
  const legacyChords = getLegacySearchBindings(platform)[SEARCH_ACTION] ?? []
  return {
    kind: 'eligible',
    keepsLegacyKey: legacyChords.every((chord) => searchHasBinding(platform, optedIn, chord))
  }
}

/** True when an accepted choice actually gave Search Mod+K with no other owner. */
export function searchShortcutOptInIsEffective(offer: SearchShortcutOffer): boolean {
  return offer.kind === 'accepted' && offer.searchOnModK && offer.owners.length === 0
}
