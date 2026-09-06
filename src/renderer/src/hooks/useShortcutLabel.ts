import {
  formatKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  isDoubleTapBinding,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../shared/keybindings'
import { useAppStore } from '../store'
import { getShortcutPlatform } from '../lib/shortcut-platform'

export { getShortcutPlatform }

export type ShortcutKeyComboDetails = {
  keys: string[]
  doubleTap: boolean
}

// Why: these run in render bodies of components that re-render constantly, and every call is two full keybinding parses.
// The store hands out a new overrides object on every keybinding edit, so keying the cache on that object gives exact
// invalidation: an edit can never be served from a stale entry, and the old entry is dropped with the old object.
const cachesByOverrides = new WeakMap<KeybindingOverrides, Map<string, unknown>>()
const defaultOverridesCache = new Map<string, unknown>()

function labelCache(overrides: KeybindingOverrides | undefined): Map<string, unknown> {
  if (!overrides) {
    return defaultOverridesCache
  }
  let cache = cachesByOverrides.get(overrides)
  if (!cache) {
    cache = new Map()
    cachesByOverrides.set(overrides, cache)
  }
  return cache
}

function memoizeShortcut<T>(
  kind: string,
  actionId: KeybindingActionId,
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides | undefined,
  compute: () => T
): T {
  const cache = labelCache(overrides)
  const key = `${platform}\u0000${kind}\u0000${actionId}`
  if (cache.has(key)) {
    return cache.get(key) as T
  }
  const value = compute()
  cache.set(key, value)
  return value
}

export function formatShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string {
  const platform = getShortcutPlatform()
  return memoizeShortcut('label', actionId, platform, overrides, () =>
    formatKeybindingList(getEffectiveKeybindingsForAction(actionId, platform, overrides), platform)
  )
}

export function formatPrimaryShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string {
  const platform = getShortcutPlatform()
  return memoizeShortcut('primary', actionId, platform, overrides, () => {
    const [binding] = getEffectiveKeybindingsForAction(actionId, platform, overrides)
    return binding ? formatKeybindingList([binding], platform) : 'Unassigned'
  })
}

export function useShortcutLabel(actionId: KeybindingActionId): string {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutLabel(actionId, keybindings)
}

// Why: returns null for unbound actions instead of the display sentinel
// 'Unassigned', so callers decide whether to render a hint without coupling
// UI logic to formatter copy (which may change or become localized).
export function formatOptionalShortcutLabel(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): string | null {
  const platform = getShortcutPlatform()
  return memoizeShortcut('optional', actionId, platform, overrides, () => {
    const bindings = getEffectiveKeybindingsForAction(actionId, platform, overrides)
    if (bindings.length === 0) {
      return null
    }
    return formatKeybindingList(bindings, platform)
  })
}

export function useOptionalShortcutLabel(actionId: KeybindingActionId): string | null {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatOptionalShortcutLabel(actionId, keybindings)
}

export function formatShortcutKeyComboDetails(
  actionId: KeybindingActionId,
  overrides?: KeybindingOverrides
): ShortcutKeyComboDetails[] {
  const platform = getShortcutPlatform()
  // The returned array is shared across callers now, so treat it as read-only (every current caller does).
  return memoizeShortcut('combo', actionId, platform, overrides, () =>
    getEffectiveKeybindingsForAction(actionId, platform, overrides).map((binding) => ({
      keys: formatKeybinding(binding, platform),
      doubleTap: isDoubleTapBinding(binding)
    }))
  )
}

export function useShortcutKeyComboDetails(
  actionId: KeybindingActionId
): ShortcutKeyComboDetails[] {
  const keybindings = useAppStore((state) => state.keybindings)
  return formatShortcutKeyComboDetails(actionId, keybindings)
}

export function useShortcutKeyDetails(actionId: KeybindingActionId): ShortcutKeyComboDetails {
  return useShortcutKeyComboDetails(actionId)[0] ?? { keys: [], doubleTap: false }
}
