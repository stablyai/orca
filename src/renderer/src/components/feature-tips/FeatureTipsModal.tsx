import type { JSX } from 'react'
import { Mic, Sparkles } from 'lucide-react'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import {
  getCompletedFeatureTipIds,
  getOrderedUnseenFeatureTips,
  type FeatureTip
} from '../../../../shared/feature-tips'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'

function getTipPreview(tip: FeatureTip): JSX.Element {
  switch (tip.action) {
    case 'enable-voice':
      return <Mic className="size-8 text-foreground" />
  }
}

export default function FeatureTipsModal(): JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const seenTipIds = useAppStore((s) => s.featureTipsSeenIds)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const isOpen = activeModal === 'feature-tips'
  const pendingTips = getOrderedUnseenFeatureTips({
    seenTipIds: new Set(seenTipIds),
    completedTipIds: getCompletedFeatureTipIds({
      voiceDictationEnabled: settings?.voice?.enabled === true
    })
  })
  const currentTip = pendingTips[0] ?? null

  const markCurrentTipSeen = (): void => {
    if (currentTip) {
      markFeatureTipsSeen([currentTip.id])
    }
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      markCurrentTipSeen()
      closeModal()
    }
  }

  const handleSkip = (): void => {
    markCurrentTipSeen()
    closeModal()
  }

  const handlePrimaryAction = (): void => {
    if (!currentTip) {
      return
    }

    markFeatureTipsSeen([currentTip.id])
    switch (currentTip.action) {
      case 'enable-voice': {
        const voice = settings?.voice ?? getDefaultVoiceSettings()
        void updateSettings({
          voice: {
            ...voice,
            enabled: true
          }
        })
        closeModal()
        openSettingsTarget({ pane: 'voice', repoId: null })
        openSettingsPage()
      }
    }
  }

  if (!isOpen || !currentTip) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg gap-5 p-7" showCloseButton>
        <DialogHeader className="items-center gap-3 pr-8 text-center sm:text-center">
          <Badge
            variant="outline"
            className="gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-[0.08em]"
          >
            <Sparkles className="size-3" />
            {currentTip.eyebrow}
          </Badge>
          <div className="flex size-20 items-center justify-center rounded-xl border border-border bg-muted/40">
            {getTipPreview(currentTip)}
          </div>
          <DialogTitle className="text-2xl font-semibold tracking-tight">
            {currentTip.title}
          </DialogTitle>
          <DialogDescription className="max-w-sm text-sm leading-relaxed">
            {currentTip.description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="sm:justify-center">
          <Button variant="ghost" onClick={handleSkip}>
            Maybe Later
          </Button>
          <Button onClick={handlePrimaryAction}>{currentTip.ctaLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
