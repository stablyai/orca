import { useAppStore } from '../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { cn } from '@/lib/class-names'
import { MACHINE_NAME_MAX_LENGTH } from '../../../../shared/machine-name'
import { DebouncedSettingsTextInput } from '../settings/form-controls/DebouncedSettingsTextInput'
import { usePublishedMachineName } from './use-published-machine-name'

type MachineNameFieldProps = {
  /** Distinct per mount so two surfaces in one DOM never share an input id. */
  id?: string
  /** Applied to the root so a grid host can place the field without a wrapper that outlives it. */
  className?: string
}

/** Machine-wide peer-visible name; blank uses detection, and only this computer’s pairing surfaces edit it. */
export function MachineNameField({
  id = 'machine-name',
  className
}: MachineNameFieldProps): React.JSX.Element | null {
  const t = useTranslate()
  const machineName = useAppStore((s) => s.settings?.machineName ?? '')
  const updateSettings = useAppStore((s) => s.updateSettings)
  const publishedMachineName = usePublishedMachineName(machineName)
  const descriptionId = `${id}-description`

  // Web mirrors cannot persist machine names; edit the name on its owning host.
  if (isWebClientLocation()) {
    return null
  }

  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {t('auto.components.settings.MachineNameField.label', 'Machine name')}
      </label>
      <DebouncedSettingsTextInput
        id={id}
        value={machineName}
        commit={(name) => void updateSettings({ machineName: name })}
        maxLength={MACHINE_NAME_MAX_LENGTH}
        placeholder={
          publishedMachineName ??
          t('auto.components.settings.MachineNameField.placeholder', 'Detected automatically')
        }
        aria-describedby={descriptionId}
      />
      <p id={descriptionId} className="text-xs text-muted-foreground">
        {publishedMachineName
          ? t(
              'auto.components.settings.MachineNameField.description',
              'Other devices and hosts see “{{name}}”. Leave this blank to use the computer’s own name.',
              { name: publishedMachineName }
            )
          : t(
              'auto.components.settings.MachineNameField.pending',
              'Other devices and hosts see this name. Leave it blank to use the detected computer name.'
            )}
      </p>
    </div>
  )
}
