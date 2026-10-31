import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { resolveProjectGroupingMode } from '../../../../shared/project-grouping'
import { useContextualTour } from './use-contextual-tour'

export function useProjectGroupingUpgradeTip(): void {
  const audience = useAppStore((state) => state.projectGroupingUpgradeTipAudience)
  const mode = useAppStore((state) =>
    audience?.membership === 'eligible'
      ? resolveProjectGroupingMode(audience.projectId, state.settings)
      : null
  )
  const hydrated = useAppStore((state) => state.projectGroupingSettingsHydrated)
  const markSeen = useAppStore((state) => state.markContextualToursSeen)
  useEffect(() => {
    if (hydrated && audience?.membership === 'eligible' && mode !== 'repository') {
      markSeen(['project-grouping-upgrade'])
    }
  }, [audience, hydrated, markSeen, mode])
  useContextualTour(
    'project-grouping-upgrade',
    hydrated && audience?.membership === 'eligible' && mode === 'repository',
    undefined,
    { recordFeatureInteraction: false }
  )
}
