import type { JSX } from 'react'
import { getFeatureWallOpenSource } from './tour/feature-wall-open-source'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store/index'
import { FeatureWallTourSurface } from './FeatureWallTourSurface'
import { useTranslate } from '@/i18n/use-translate'

export default function FeatureWallModal(): JSX.Element | null {
  const t = useTranslate()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const isOpen = activeModal === 'feature-wall'
  const source = getFeatureWallOpenSource(modalData)

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      closeModal()
    }
  }

  if (!isOpen) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="grid h-[min(780px,calc(100vh-2rem))] w-[min(1240px,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-none"
        tabIndex={-1}
      >
        <DialogHeader className="gap-1 border-b border-border px-7 py-4">
          <DialogTitle className="text-lg">
            {t('auto.components.feature.wall.FeatureWallModal.3567e147c8', 'Get to know Orca')}
          </DialogTitle>
          {/* Provide Radix’s accessible description without duplicating visible tour copy. */}
          <DialogDescription className="sr-only">
            {t(
              'auto.components.feature.wall.FeatureWallModal.33dca8bbbe',
              'A short, workflow-by-workflow tour of Orca.'
            )}
          </DialogDescription>
        </DialogHeader>

        <FeatureWallTourSurface isOpen={isOpen} source={source} onDone={closeModal} />
      </DialogContent>
    </Dialog>
  )
}
