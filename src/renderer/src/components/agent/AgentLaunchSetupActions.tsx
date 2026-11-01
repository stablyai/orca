import { CornerDownLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  agentPickerButtonOrder,
  type AgentPickerEntry,
  type AgentPickerSurface
} from '../../../../shared/agent-launch-picker'

export function AgentLaunchSetupActions({
  entry,
  mode,
  disabled,
  surface,
  onUse
}: {
  entry: AgentPickerEntry
  mode: 'launch' | 'select'
  disabled?: boolean
  surface: AgentPickerSurface
  onUse: (surface: AgentPickerSurface) => void
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-2">
      {mode === 'select' ? (
        <Button type="button" size="xs" disabled={disabled} onClick={() => onUse(surface)}>
          {translate('agentPicker.use', 'Use')}
        </Button>
      ) : (
        agentPickerButtonOrder(entry).map((surface) => (
          <Button
            key={surface}
            type="button"
            size="xs"
            disabled={disabled}
            variant={surface === entry.defaultSurface ? 'default' : 'outline'}
            onClick={() => onUse(surface)}
          >
            {surface === 'chat'
              ? translate('agentPicker.launchChat', 'Launch chat')
              : translate('agentPicker.launchTerminal', 'Launch terminal')}
            {surface === entry.defaultSurface ? (
              <CornerDownLeft className="size-3 opacity-60" />
            ) : null}
          </Button>
        ))
      )}
    </div>
  )
}
