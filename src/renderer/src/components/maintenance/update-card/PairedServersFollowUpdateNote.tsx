import { isListedRemoteServer } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'

export function PairedServersFollowUpdateNote(): React.JSX.Element | null {
  const t = useTranslate()
  const showNote = useAppStore(
    (state) =>
      state.settings?.updateRemoteServersWithApp !== false &&
      state.runtimeEnvironments.some(isListedRemoteServer)
  )
  if (!showNote) {
    return null
  }
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {t(
        'auto.components.UpdateCard.pairedServersFollowUpdate',
        'Remote servers update automatically after Orca restarts.'
      )}
    </p>
  )
}
