import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { hasFeatureInteraction } from '../../../../../../shared/feature-interactions'

export function useAddProjectIntroduction(isOpen: boolean): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const introductionDone = useAppStore((s) =>
    hasFeatureInteraction(s.featureInteractions, 'project-add-introduction')
  )
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  useEffect(() => {
    if (isOpen && persistedUIReady && !introductionDone) {
      void recordFeatureInteraction('project-add-introduction')
    }
  }, [isOpen, persistedUIReady, introductionDone, recordFeatureInteraction])
}
