import { getEffectiveKeybindingsForDefinition } from '../../../../../shared/keybindings/effective'
import { formatKeybindingList } from '../../../../../shared/keybindings/formatting'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import type { ShortcutGroup } from './shortcut-groups'

export type ShortcutExportEntry = {
  id: string
  title: string
  group: string
  bindings: string[]
  display: string
}

export function buildShortcutExportJson(options: {
  groups: readonly ShortcutGroup[]
  keybindings: KeybindingOverrides
  platform: NodeJS.Platform
}): string {
  const shortcuts: ShortcutExportEntry[] = options.groups.flatMap((group) =>
    group.items.map((definition) => {
      const bindings = getEffectiveKeybindingsForDefinition(
        definition,
        options.platform,
        options.keybindings
      )
      return {
        id: definition.id,
        title: definition.title,
        group: group.title,
        bindings,
        display: formatKeybindingList(bindings, options.platform)
      }
    })
  )
  return JSON.stringify({ platform: options.platform, shortcuts }, null, 2)
}
