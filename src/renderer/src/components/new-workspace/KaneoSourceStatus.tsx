import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { useKaneoUrlSource } from './use-kaneo-url-source'

export function KaneoSourceStatus({
  source,
  id
}: {
  source: ReturnType<typeof useKaneoUrlSource>
  id: string
}): React.JSX.Element | null {
  if (!source.intent) {
    return null
  }
  function openSettings() {
    const state = useAppStore.getState()
    state.openSettingsTarget({ pane: 'integrations', repoId: null })
    state.openSettingsPage()
    state.closeModal()
  }
  return (
    <div
      id={id}
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>
        {source.error ??
          (source.loading
            ? translate('kaneo.loadingTask', 'Loading Kaneo task…')
            : translate('kaneo.taskReady', 'Select the Kaneo task to link it to this workspace.'))}
      </span>
      {source.error ? (
        <>
          <Button type="button" size="sm" variant="ghost" onClick={source.retry}>
            {translate('kaneo.retry', 'Retry')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={openSettings}>
            {translate('kaneo.openSettings', 'Open settings')}
          </Button>
        </>
      ) : null}
    </div>
  )
}
