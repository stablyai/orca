import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type {
  AgentPickerEntry,
  AgentPickerSurface
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { AgentLaunchSurfaceButtons } from './AgentLaunchSetupFooter'

/** Select mode's buttons: a launch entry picks its surface; a text card's Use stages its draft. */
export function AgentLaunchSetupActions({
  entry,
  disabled,
  surface,
  onUse
}: {
  entry: AgentPickerEntry
  disabled?: boolean
  surface: AgentPickerSurface
  onUse: (surface: AgentPickerSurface) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-2">
      {entry.textGeneration ? (
        <Button type="button" size="xs" disabled={disabled} onClick={() => onUse(surface)}>
          {t('agentPicker.use', 'Use')}
        </Button>
      ) : (
        <AgentLaunchSurfaceButtons
          entry={entry}
          disabled={disabled}
          primary={surface}
          onSelect={onUse}
        />
      )}
    </div>
  )
}
