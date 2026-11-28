import { findKeybindingConflicts } from './formatting'
import {
  getKeybindingDefinition,
  isKeybindingActionId,
  getLegacySearchBindings,
  LEGACY_TAB_SWITCH_BINDINGS
} from './definitions'
import { getDefaultBindings } from './effective'
import { getKeybindingConflictIdentity, keybindingConflictIdentities } from './matching-key'
import type { KeybindingActionId, KeybindingOverrides } from './types'

/** Ignored actions are inert: their overrides leave the resolved map and their defaults never conflict. */
export function resolveKeybindingOverrides(
  platform: NodeJS.Platform,
  rawExplicitOverrides: KeybindingOverrides,
  defaultOverrides: KeybindingOverrides,
  ignoredActionIds: readonly KeybindingActionId[] = []
): KeybindingOverrides {
  const explicitOverrides = omitKeybindingActionOverrides(rawExplicitOverrides, ignoredActionIds)
  const inherited = omitKeybindingActionOverrides({ ...defaultOverrides }, ignoredActionIds)
  for (const actionId of Object.keys(explicitOverrides)) {
    if (isKeybindingActionId(actionId)) {
      delete inherited[actionId]
    }
  }
  while (true) {
    const conflicts = findKeybindingConflicts(
      platform,
      { ...inherited, ...explicitOverrides },
      { includeMainProcessInterception: true, ignoredActionIds }
    )
    let changed = false
    for (const conflict of conflicts) {
      const identity = getKeybindingConflictIdentity(conflict.binding, platform)
      for (const actionId of conflict.actionIds) {
        const definition = getKeybindingDefinition(actionId)
        // Fresh profiles must also yield the new search default to shared explicit choices.
        const bindings =
          inherited[actionId] ??
          (actionId === 'worktree.palette' &&
          definition &&
          !Object.hasOwn(explicitOverrides, actionId)
            ? getDefaultBindings(definition, platform)
            : undefined)
        if (!bindings) {
          continue
        }
        const retained = bindings.filter(
          (binding) => !keybindingConflictIdentities(actionId, binding, platform).includes(identity)
        )
        if (retained.length !== bindings.length) {
          // Keep an empty mask: falling back to a swapped default can introduce another conflict.
          inherited[actionId] = retained
          changed = true
        }
      }
    }
    if (!changed) {
      return { ...inherited, ...explicitOverrides }
    }
  }
}

export function getKeybindingResetBindings(
  actionId: KeybindingActionId,
  platform: NodeJS.Platform,
  commonOverrides: KeybindingOverrides
): string[] | null {
  if (Object.hasOwn(commonOverrides, actionId)) {
    return null
  }
  // Persist rollout resets so another profile's inherited defaults cannot reappear.
  const migratedAction =
    Object.hasOwn(LEGACY_TAB_SWITCH_BINDINGS, actionId) ||
    Object.hasOwn(getLegacySearchBindings(platform), actionId)
  const definition = getKeybindingDefinition(actionId)
  return migratedAction && definition ? getDefaultBindings(definition, platform) : null
}

export function omitKeybindingActionOverrides(
  overrides: KeybindingOverrides,
  actionIds: readonly KeybindingActionId[]
): KeybindingOverrides {
  if (!actionIds.some((actionId) => Object.hasOwn(overrides, actionId))) {
    return overrides
  }
  const next = { ...overrides }
  for (const actionId of actionIds) {
    delete next[actionId]
  }
  return next
}
