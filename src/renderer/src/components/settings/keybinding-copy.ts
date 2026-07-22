import {
  KEYBINDING_DEFINITIONS,
  type KeybindingActionId,
  type KeybindingDefinition
} from '../../../../shared/keybindings'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export type LocalizedKeybindingGroupTitle = {
  // Raw shared `group` string — stays the row/lookup identity across locales.
  group: string
  title: string
}

function localizeDefinition(definition: KeybindingDefinition): KeybindingDefinition {
  return {
    ...definition,
    title: translate(`keybindings.actions.${definition.id}.title`, definition.title)
  }
}

export const getLocalizedKeybindingDefinitions = createLocalizedCatalog(
  (): readonly KeybindingDefinition[] => KEYBINDING_DEFINITIONS.map(localizeDefinition)
)

const LOCALIZED_DEFINITIONS_BY_ID = createLocalizedCatalog(
  (): ReadonlyMap<KeybindingActionId, KeybindingDefinition> =>
    new Map(getLocalizedKeybindingDefinitions().map((definition) => [definition.id, definition]))
)

export function getLocalizedKeybindingDefinition(
  actionId: KeybindingActionId
): KeybindingDefinition | null {
  return LOCALIZED_DEFINITIONS_BY_ID().get(actionId) ?? null
}

// Why: derive each title's localized text from its own action id, falling back to the
// raw title so an id somehow missing from KEYBINDING_DEFINITIONS still renders something.
export function getLocalizedKeybindingTitle(definition: Pick<KeybindingDefinition, 'id' | 'title'>): string {
  return getLocalizedKeybindingDefinition(definition.id)?.title ?? definition.title
}

// Why: groups only exist as a plain display string on each definition — slug it once so
// the ~10 distinct names get stable, renamable-safe i18n keys instead of keying on the text itself.
function slugifyGroupTitle(group: string): string {
  return group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueGroupTitles(): readonly string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const definition of KEYBINDING_DEFINITIONS) {
    if (!seen.has(definition.group)) {
      seen.add(definition.group)
      result.push(definition.group)
    }
  }
  return result
}

export const getLocalizedKeybindingGroupTitles = createLocalizedCatalog(
  (): readonly LocalizedKeybindingGroupTitle[] =>
    uniqueGroupTitles().map((group) => ({
      group,
      title: translate(`keybindings.groups.${slugifyGroupTitle(group)}.title`, group)
    }))
)

const LOCALIZED_GROUP_TITLES_BY_RAW = createLocalizedCatalog(
  (): ReadonlyMap<string, string> =>
    new Map(getLocalizedKeybindingGroupTitles().map((entry) => [entry.group, entry.title]))
)

export function getLocalizedKeybindingGroupTitle(rawGroupTitle: string): string {
  return LOCALIZED_GROUP_TITLES_BY_RAW().get(rawGroupTitle) ?? rawGroupTitle
}
