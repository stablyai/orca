import { useAppStore } from '@/store/index'
import {
  usePluginCommands,
  type ActivePluginCommand
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { getLegacySearchBindings } from '../../../../shared/keybindings/definitions'
import { formatKeybindingList } from '../../../../shared/keybindings/formatting'
import {
  planSearchShortcutOptInForSnapshot,
  toSearchShortcutPluginOwners,
  type SearchShortcutOffer
} from '../../../../shared/keybindings/search-shortcut-opt-in'
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

// Snapshots and plugin lists are replaced on change, so one plan per pair keeps opens and keystrokes free.
const statesBySnapshot = new WeakMap<
  KeybindingFileSnapshot,
  WeakMap<readonly ActivePluginCommand[], SearchShortcutOfferState | null>
>()

function buildOfferState(
  snapshot: KeybindingFileSnapshot,
  pluginCommands: readonly ActivePluginCommand[]
): SearchShortcutOfferState | null {
  const offer = planSearchShortcutOptInForSnapshot(
    snapshot,
    toSearchShortcutPluginOwners(pluginCommands)
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
  pluginCommands: readonly ActivePluginCommand[]
): SearchShortcutOfferState | null {
  let byPlugins = statesBySnapshot.get(snapshot)
  if (!byPlugins) {
    byPlugins = new WeakMap()
    statesBySnapshot.set(snapshot, byPlugins)
  }
  if (!byPlugins.has(pluginCommands)) {
    byPlugins.set(pluginCommands, buildOfferState(snapshot, pluginCommands))
  }
  return byPlugins.get(pluginCommands) ?? null
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
  return getSearchShortcutOfferState(snapshot, usePluginCommands())
}
