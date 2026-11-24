import { useBotHostLabels } from '@/components/bots/use-bot-host-label'
import { getTranslatedExecutionHostLabel } from '@/runtime/hosts/display/execution-host-label'
import { useTranslate } from '@/i18n/use-translate'
import { selectCommanderHost, useCommanderHostOptions } from './selected-commander-host'

export function CommanderHostPicker(): React.JSX.Element | null {
  const t = useTranslate()
  const { selected, live } = useCommanderHostOptions()
  const offline = !live.includes(selected)
  const labels = useBotHostLabels(offline ? [...live, selected] : live)
  if (live.length < 2 && !offline) {
    return null
  }
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span>{t('commander.chatHost', 'Commander host')}</span>
      <select
        value={selected}
        onChange={(event) => selectCommanderHost(event.target.value)}
        className="h-8 max-w-44 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-ring"
      >
        {offline && (
          <option value={selected} disabled>
            {labels.get(selected) || getTranslatedExecutionHostLabel(selected, t)} ·{' '}
            {t('commander.hostOffline', 'Offline')}
          </option>
        )}
        {live.map((id) => (
          <option key={id} value={id}>
            {labels.get(id) || getTranslatedExecutionHostLabel(id, t)}
          </option>
        ))}
      </select>
    </label>
  )
}
