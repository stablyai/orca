import { useCallback, useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'

export function FeatureTourNudge(): JSX.Element | null {
  const visible = useAppStore((s) => s.featureTourNudgeVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const openModal = useAppStore((s) => s.openModal)
  const hideFeatureTourNudge = useAppStore((s) => s.hideFeatureTourNudge)
  const notifiedRef = useRef(false)

  const handleOpenTour = useCallback((): void => {
    openModal('feature-wall', { source: 'popup' })
  }, [openModal])

  useEffect(() => {
    if (!visible) {
      notifiedRef.current = false
      return
    }
    if (activeModal === 'feature-wall' || activeModal === 'feature-tips' || notifiedRef.current) {
      return
    }
    notifiedRef.current = true
    toast.message('You can take the tour anytime', {
      description: 'Open Help > Explore Orca when you want the tour.',
      action: {
        label: 'Take the tour',
        onClick: handleOpenTour
      }
    })
    // Why: the first-agent education surface should be a quick notification,
    // not the old persistent animated popup.
    hideFeatureTourNudge()
  }, [activeModal, handleOpenTour, hideFeatureTourNudge, visible])

  return null
}
