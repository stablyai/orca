import { useAppStore } from '@/store/index'
import {
  collectActivePluginCommands,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import { getLegacySearchBindings } from '../../../../shared/keybindings/definitions'
import { formatKeybindingList } from '../../../../shared/keybindings/formatting'
import {
  planSearchShortcutOptInForSnapshot,
  type SearchShortcutOffer
} from '../../../../shared/keybindings/search-shortcut-opt-in'
import { toSearchShortcutPluginOwners } from '../../../../shared/keybindings/search-shortcut-plugin-owners'
import type {
  KeybindingFileSnapshot,
  KeybindingPlatform
} from '../../../../shared/keybindings/types'

export type SearchShortcutOfferState = {
  offer: Exclude<SearchShortcutOffer, { kind: 'none' }>
  platform: KeybindingPlatform
  dismissed: boolean
  searchKeyLabel: string
  legacyKeyLabel: string
}

// Both keys are store-owned and replaced only on change, so palette opens and keystrokes reuse one plan.
const statesBySnapshot = new WeakMap<
  KeybindingFileSnapshot,
  WeakMap<readonly PluginHostListEntry[], SearchShortcutOfferState | null>
>()

function buildOfferState(
  snapshot: KeybindingFileSnapshot,
  plugins: readonly PluginHostListEntry[]
): SearchShortcutOfferState | null {
  const offer = planSearchShortcutOptInForSnapshot(
    snapshot,
    toSearchShortcutPluginOwners(collectActivePluginCommands(plugins))
  )
  if (offer.kind === 'none') {
    return null
  }
  return {
    offer,
    platform: snapshot.platform,
    dismissed: snapshot.searchShortcut?.choice === 'dismissed',
    searchKeyLabel: formatKeybindingList(['Mod+K'], snapshot.platform),
    legacyKeyLabel: formatKeybindingList(
      getLegacySearchBindings(snapshot.platform)['worktree.palette'] ?? [],
      snapshot.platform
    )
  }
}

export function getSearchShortcutOfferState(
  snapshot: KeybindingFileSnapshot,
  plugins: readonly PluginHostListEntry[]
): SearchShortcutOfferState | null {
  let byPlugins = statesBySnapshot.get(snapshot)
  if (!byPlugins) {
    byPlugins = new WeakMap()
    statesBySnapshot.set(snapshot, byPlugins)
  }
  if (!byPlugins.has(plugins)) {
    byPlugins.set(plugins, buildOfferState(snapshot, plugins))
  }
  return byPlugins.get(plugins) ?? null
}

/** Cheap gate: only legacy search-cohort profiles carry `searchShortcut`, so others never plan or subscribe further. */
export function useLegacySearchShortcutSnapshot(): KeybindingFileSnapshot | null {
  return useAppStore((state) =>
    state.keybindingSnapshot?.searchShortcut ? state.keybindingSnapshot : null
  )
}

/** Null when Search already has Mod+K; mount only under a non-null legacy snapshot. */
export function useSearchShortcutOfferState(
  snapshot: KeybindingFileSnapshot
): SearchShortcutOfferState | null {
  // The app shell's global shortcut hook keeps the plugin list loaded.
  return getSearchShortcutOfferState(
    snapshot,
    usePluginPanelsStore((state) => state.plugins)
  )
}
