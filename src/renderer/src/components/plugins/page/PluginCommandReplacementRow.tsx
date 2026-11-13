import { Replace } from 'lucide-react'
import { getKeybindingDefinition, isKeybindingActionId } from '../../../../../shared/keybindings'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Switch } from '../../ui/switch'
import { DetailRow } from './PluginDetailSections'

/** Orca's own name for a built-in action. */
export function builtInActionTitle(actionId: string): string {
  return (isKeybindingActionId(actionId) && getKeybindingDefinition(actionId)?.title) || actionId
}

/** A command that runs in place of a built-in action, with the switch that keeps Orca's own. */
export function PluginCommandReplacementRow({
  command
}: {
  command: { title: string; replaces: string; replacedBy?: string }
}): React.JSX.Element {
  const t = useTranslate()
  const turnedOff = useAppStore((state) => state.settings?.pluginReplacementsOff)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const action = builtInActionTitle(command.replaces)
  const on = !(turnedOff ?? []).includes(command.replaces)
  const setOn = (next: boolean): void => {
    const others = (turnedOff ?? []).filter((id) => id !== command.replaces)
    void updateSettings({ pluginReplacementsOff: next ? others : [...others, command.replaces] })
  }
  return (
    <DetailRow
      icon={<Replace />}
      title={t(
        'auto.components.plugins.PluginCommandReplacementRow.title',
        '{{value0}} runs instead of Orca’s {{value1}}',
        { value0: command.title, value1: action }
      )}
      wrap
      detailTone={command.replacedBy ? 'warning' : 'default'}
      detail={
        command.replacedBy
          ? t(
              'auto.components.plugins.PluginCommandReplacementRow.conflict',
              'Not used: {{value0}}, installed first, replaces it',
              { value0: command.replacedBy }
            )
          : t(
              'auto.components.plugins.PluginCommandReplacementRow.detail',
              'From its shortcut, the palette and menus. If the plugin fails, Orca’s own runs.'
            )
      }
      trailing={
        command.replacedBy ? null : (
          <Switch
            checked={on}
            onCheckedChange={setOn}
            aria-label={t(
              'auto.components.plugins.PluginCommandReplacementRow.switch',
              'Use {{value0}} instead of Orca’s {{value1}}',
              { value0: command.title, value1: action }
            )}
          />
        )
      }
    />
  )
}
