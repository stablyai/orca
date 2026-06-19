import React from 'react'
import {
  formatKeybinding,
  getEffectiveKeybindingsForAction,
  isDoubleTapBinding,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { cn } from '@/lib/utils'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { CommandItem } from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { CmdJShortcutResult } from './shortcut-results'

export function getShortcutSettingsTarget(actionId: CmdJShortcutResult['actionId']): {
  pane: 'shortcuts'
  repoId: null
  intent: 'shortcut-action'
  actionId: CmdJShortcutResult['actionId']
} {
  return {
    pane: 'shortcuts',
    repoId: null,
    intent: 'shortcut-action',
    actionId
  }
}

export type ShortcutPaletteItem = {
  id: string
  type: 'shortcut'
  result: CmdJShortcutResult
  effectiveBindings: readonly string[]
}

export function buildShortcutBindingSearchText(
  definitions: readonly KeybindingDefinition[],
  keybindings: KeybindingOverrides
): Partial<Record<CmdJShortcutResult['actionId'], readonly string[]>> {
  const platform = getShortcutPlatform()
  const labelsByActionId: Partial<Record<CmdJShortcutResult['actionId'], readonly string[]>> = {}
  for (const definition of definitions) {
    const effective = getEffectiveKeybindingsForAction(definition.id, platform, keybindings)
    labelsByActionId[definition.id] = effective.flatMap((binding) => [
      binding,
      formatKeybinding(binding, platform).join(platform === 'darwin' ? '' : '+'),
      formatKeybinding(binding, platform).join(' ')
    ])
  }
  return labelsByActionId
}

export function buildShortcutPaletteItems({
  results,
  keybindings
}: {
  results: readonly CmdJShortcutResult[]
  keybindings: KeybindingOverrides
}): ShortcutPaletteItem[] {
  const platform = getShortcutPlatform()
  return results.map((result) => ({
    id: result.id,
    type: 'shortcut',
    result,
    effectiveBindings: getEffectiveKeybindingsForAction(result.actionId, platform, keybindings)
  }))
}

export function ShortcutPaletteCommandItem({
  item,
  onSelect
}: {
  item: ShortcutPaletteItem
  onSelect: () => void
}): React.JSX.Element {
  const platform = getShortcutPlatform()
  const firstBinding = item.effectiveBindings[0]

  return (
    <CommandItem
      value={item.id}
      onSelect={onSelect}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-foreground">
              {item.result.title}
            </span>
            <span className="shrink-0 rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
              {translate('auto.components.cmd-j.shortcutPaletteItems.shortcutBadge', 'Shortcut')}
            </span>
          </div>
          <div className="mt-1 truncate text-[12px] leading-5 text-muted-foreground/88">
            {item.result.description}
          </div>
        </div>
        <div className="shrink-0">
          {firstBinding ? (
            <ShortcutKeyCombo
              keys={formatKeybinding(firstBinding, platform)}
              doubleTap={isDoubleTapBinding(firstBinding)}
              keyCapClassName="bg-background/70"
            />
          ) : (
            <span className="inline-flex h-7 items-center rounded-md border border-dashed border-border/70 px-2 text-xs font-medium text-muted-foreground">
              {translate('auto.components.cmd-j.shortcutPaletteItems.unassigned', 'Unassigned')}
            </span>
          )}
        </div>
      </div>
    </CommandItem>
  )
}
