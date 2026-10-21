import {
  keybindingYieldsToEmacsEditor,
  type KeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import type { EditorKeybindingsPreset } from '../../../../shared/editor-keybindings-preset'
import { translate } from '@/i18n/i18n'

// Badge for shortcuts the Emacs editor preset takes over while the file editor has focus. Only
// shown once the preset is on, so Default / Vim users see no change in Settings → Shortcuts.
export type ShortcutEditorStatus = {
  label: string
  description: string
}

export function getShortcutEditorStatus(
  definition: KeybindingDefinition,
  editorKeybindings: EditorKeybindingsPreset | undefined,
  platform: NodeJS.Platform,
  keybindings: KeybindingOverrides
): ShortcutEditorStatus | undefined {
  if (
    editorKeybindings !== 'emacs' ||
    !keybindingYieldsToEmacsEditor(definition.id, platform, keybindings)
  ) {
    return undefined
  }
  return {
    label: translate('auto.components.settings.ShortcutsPane.6d2e8b4a1f', 'Emacs editor'),
    description: translate(
      'auto.components.settings.ShortcutsPane.9c4f1e7b3d',
      'Inactive while the file editor has keyboard focus and the Emacs preset is on.'
    )
  }
}
