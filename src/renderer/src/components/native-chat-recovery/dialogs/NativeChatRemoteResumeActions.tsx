import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatRestartStore } from '../offers/native-chat-restart-runtime-store'

export function NativeChatRemoteResumeActions({
  store,
  machineName,
  chosen,
  busy,
  resume,
  dismiss,
  resumeButtonRef
}: {
  store: NativeChatRestartStore
  machineName: string
  chosen: readonly string[]
  busy: boolean
  resume: (ids: string[]) => void
  dismiss: () => void
  resumeButtonRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  const all = [...chosen]
  const startedHere = all.filter(store.startedHere)
  return (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
        {t('auto.components.NativeChatResumeOnRestartModal.serverDismiss', 'Dismiss')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || all.length === 0}
        onClick={() => resume(all)}
      >
        {t(
          'auto.components.NativeChatResumeOnRestartModal.serverResumeAll',
          'Resume all {{count}} on {{machine}}',
          { count: all.length, machine: machineName }
        )}
      </Button>
      <Button
        ref={resumeButtonRef}
        variant="default"
        size="sm"
        disabled={busy || startedHere.length === 0}
        onClick={() => resume(startedHere)}
      >
        {t(
          'auto.components.NativeChatResumeOnRestartModal.serverResumeHereCount',
          'Resume {{count}} chats started here',
          { count: startedHere.length, defaultValue_one: 'Resume {{count}} chat started here' }
        )}
      </Button>
    </>
  )
}
