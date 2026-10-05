import { useAppStore } from '@/store'
import { normalizeVisibleTaskProviders } from '../../../../shared/task-providers'

/** False when YouTrack is hidden in Settings → Tasks; YouTrack surfaces outside Settings stay quiet then. */
export function useYouTrackVisible(): boolean {
  return useAppStore((state) =>
    state.settings
      ? normalizeVisibleTaskProviders(state.settings.visibleTaskProviders).includes('youtrack')
      : false
  )
}
