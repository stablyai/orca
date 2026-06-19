import type { KeybindingActionId, KeybindingDefinition } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'

export type CmdJShortcutResult = {
  id: string
  kind: 'shortcut'
  title: string
  description: string
  actionId: KeybindingActionId
  order: number
  configKeywords: string[]
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeQuery).filter(Boolean))]
}

export function buildCmdJShortcutResults({
  definitions,
  bindingSearchTextByActionId = {}
}: {
  definitions: readonly KeybindingDefinition[]
  bindingSearchTextByActionId?: Partial<Record<KeybindingActionId, readonly string[]>>
}): CmdJShortcutResult[] {
  return definitions.map((definition, order) => ({
    id: `shortcut:${definition.id}`,
    kind: 'shortcut',
    title: definition.title,
    description: translate(
      'auto.components.cmd-j.shortcutResults.description',
      '{{value0}} shortcut',
      {
        value0: definition.group
      }
    ),
    actionId: definition.id,
    order,
    configKeywords: uniqueNormalized([
      definition.id,
      definition.title,
      definition.group,
      definition.scope,
      `${definition.title} shortcut`,
      `${definition.title} keyboard shortcut`,
      `${definition.group} shortcut`,
      `${definition.scope} shortcut`,
      'shortcut',
      'shortcuts',
      'keyboard shortcut',
      'keyboard shortcuts',
      'keybinding',
      'keybindings',
      ...definition.searchKeywords,
      ...(bindingSearchTextByActionId[definition.id] ?? [])
    ])
  }))
}
