import React, { useState } from 'react'
import {
  getEffectiveKeybindingsForAction,
  getKeybindingPlatform,
  SECONDARY_DIGIT_ROW_BINDINGS,
  type KeybindingActionId,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { useAppStore } from '../../store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type SpaceShortcutPresetId = 'default' | 'arc' | 'custom'

// Why: Arc gives Spaces the prime chords, so every row swaps with whatever owns them by default —
// Spaces take Mod+1-9 and Mod+Alt+arrows, workspaces and worktree history take the vacated ranges.
function arcBindings(platform: NodeJS.Platform): Partial<Record<KeybindingActionId, string[]>> {
  return {
    'space.selectByIndex': ['Mod+1'],
    'workspace.selectByIndex': [...SECONDARY_DIGIT_ROW_BINDINGS[getKeybindingPlatform(platform)]],
    'space.next': ['Mod+Alt+ArrowRight'],
    'space.previous': ['Mod+Alt+ArrowLeft'],
    'worktree.history.back': ['Mod+Alt+Shift+ArrowLeft'],
    'worktree.history.forward': ['Mod+Alt+Shift+ArrowRight']
  }
}

const PRESET_ACTION_IDS = Object.keys(arcBindings('darwin')) as KeybindingActionId[]

function sameBindings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((binding, index) => binding === right[index])
}

export function getSpaceShortcutPreset(
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides
): SpaceShortcutPresetId {
  const arc = arcBindings(platform)
  const effective = (actionId: KeybindingActionId): string[] =>
    getEffectiveKeybindingsForAction(actionId, platform, overrides)
  if (PRESET_ACTION_IDS.every((id) => sameBindings(effective(id), arc[id] ?? []))) {
    return 'arc'
  }
  // Why: compare against the catalog rather than an empty override map so a user who re-typed a
  // default chord by hand still reads as the preset it matches.
  if (
    PRESET_ACTION_IDS.every((id) =>
      sameBindings(effective(id), getEffectiveKeybindingsForAction(id, platform))
    )
  ) {
    return 'default'
  }
  return 'custom'
}

export function SpaceShortcutPreset({
  platform
}: {
  platform: NodeJS.Platform
}): React.JSX.Element {
  const keybindings = useAppStore((state) => state.keybindings)
  const setKeybindingOverride = useAppStore((state) => state.setKeybindingOverride)
  const resetKeybindingOverride = useAppStore((state) => state.resetKeybindingOverride)
  const [saving, setSaving] = useState(false)
  const preset = getSpaceShortcutPreset(platform, keybindings)

  const applyPreset = async (next: Exclude<SpaceShortcutPresetId, 'custom'>): Promise<void> => {
    setSaving(true)
    try {
      const arc = arcBindings(platform)
      for (const actionId of PRESET_ACTION_IDS) {
        await (next === 'arc'
          ? setKeybindingOverride(actionId, arc[actionId] ?? [])
          : resetKeybindingOverride(actionId))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow
      label={translate(
        'auto.components.settings.SpaceShortcutPreset.9d7aac5159',
        'Shortcut layout'
      )}
      description={translate(
        'auto.components.settings.SpaceShortcutPreset.733f0bf4c4',
        'Arc style puts Spaces on the primary number row and arrow chords, moving workspaces and worktree history to the freed ranges.'
      )}
      control={
        <Select
          value={preset}
          disabled={saving}
          onValueChange={(value) => {
            if (value === 'default' || value === 'arc') {
              void applyPreset(value)
            }
          }}
        >
          <SelectTrigger
            className="w-[180px]"
            aria-label={translate(
              'auto.components.settings.SpaceShortcutPreset.cc2fc6b6c2',
              'Shortcut layout preset'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              {translate('auto.components.settings.SpaceShortcutPreset.02f36cf6fe', 'Orca')}
            </SelectItem>
            <SelectItem value="arc">
              {translate('auto.components.settings.SpaceShortcutPreset.2b73f91683', 'Arc')}
            </SelectItem>
            {preset === 'custom' ? (
              <SelectItem value="custom" disabled>
                {translate('auto.components.settings.SpaceShortcutPreset.90589c47f0', 'Custom')}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      }
    />
  )
}
