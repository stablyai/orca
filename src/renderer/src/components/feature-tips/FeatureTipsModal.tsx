import type { JSX } from 'react'
import { CircleCheck, Mic, Sparkles } from 'lucide-react'
import type { FeatureTip } from '../../../../shared/feature-tips'
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
import { getFeatureTipForModal } from './feature-tip-modal-state'
import { runFeatureTipPrimaryAction } from './feature-tip-primary-action'

const WAVEFORM_BAR_HEIGHTS = [30, 60, 90, 70, 100, 50, 80, 35, 65]

const AGENT_STATUS_VISUAL_ROWS = [
  {
    agent: 'Codex',
    state: 'working',
    promptClassName: 'w-[58px]',
    detailClassName: 'w-[78px]',
    animationDelay: '0.1s'
  },
  {
    agent: 'Claude',
    state: 'done',
    promptClassName: 'w-[68px]',
    detailClassName: 'w-[50px]',
    animationDelay: '0.45s'
  },
  {
    agent: 'Hermes',
    state: 'idle',
    promptClassName: 'w-[52px]',
    detailClassName: 'w-[64px]',
    animationDelay: '0.8s'
  }
] as const

function AgentStatusVisualDot({ state }: { state: 'working' | 'done' | 'idle' }): JSX.Element {
  if (state === 'working') {
    return (
      <span className="inline-flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
        <span className="size-2 rounded-full border-[1.5px] border-yellow-500 border-t-transparent animate-spin motion-reduce:animate-none" />
      </span>
    )
  }

  if (state === 'done') {
    return <CircleCheck className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
  }

  return (
    <span className="inline-flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="size-1.5 rounded-full bg-neutral-500/40" />
    </span>
  )
}

function AgentStatusSidebarVisual(): JSX.Element {
  return (
    <div
      className="feature-tip-agent-status-visual flex aspect-video w-full max-w-sm overflow-hidden rounded-md border border-border bg-muted/40 text-[10px] text-foreground"
      aria-hidden="true"
    >
      <div className="flex w-[142px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
        <div className="mb-2 flex items-center justify-between">
          <span className="h-2 w-14 rounded-full bg-sidebar-foreground/30" />
          <span className="size-2 rounded-full bg-sidebar-border" />
        </div>

        <div className="feature-tip-agent-card-highlight rounded-md border border-sidebar-border bg-card p-2 shadow-xs">
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            <span className="h-2 w-20 rounded-full bg-card-foreground/35" />
          </div>
          <div className="mt-1 h-1.5 w-16 rounded-full bg-muted-foreground/25" />

          <div className="mt-2 flex flex-col divide-y divide-border/40">
            {AGENT_STATUS_VISUAL_ROWS.map((row) => (
              <div
                key={row.agent}
                className="feature-tip-agent-row flex items-start gap-1.5 py-1"
                style={{ animationDelay: row.animationDelay }}
              >
                <AgentStatusVisualDot state={row.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 text-[10px] leading-none text-card-foreground/80">
                      {row.agent}
                    </span>
                    <span
                      className={`h-1.5 rounded-full bg-muted-foreground/35 ${row.promptClassName}`}
                    />
                  </div>
                  <div
                    className={`mt-1 h-1 rounded-full bg-muted-foreground/20 ${row.detailClassName}`}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 rounded-md border border-sidebar-border/70 bg-sidebar-accent/40 p-2 opacity-60">
          <div className="h-2 w-16 rounded-full bg-sidebar-foreground/25" />
          <div className="mt-1.5 h-1.5 w-10 rounded-full bg-sidebar-foreground/15" />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-editor-surface p-3">
        <div className="flex h-5 items-center gap-1 rounded-t-md border border-border bg-card px-2">
          <span className="size-1.5 rounded-full bg-muted-foreground/30" />
          <span className="size-1.5 rounded-full bg-muted-foreground/20" />
          <span className="size-1.5 rounded-full bg-muted-foreground/20" />
          <span className="ml-2 h-1.5 w-12 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="flex flex-1 flex-col gap-1.5 rounded-b-md border-x border-b border-border bg-background p-2">
          <span className="h-1.5 w-24 rounded-full bg-foreground/20" />
          <span className="h-1.5 w-16 rounded-full bg-foreground/15" />
          <span className="feature-tip-agent-terminal-line h-1.5 w-28 rounded-full bg-yellow-500/55" />
          <span className="h-1.5 w-20 rounded-full bg-foreground/15" />
          <span className="mt-auto h-1.5 w-14 rounded-full bg-emerald-500/55" />
        </div>
      </div>
    </div>
  )
}

function FeatureTipVisual({ tip }: { tip: FeatureTip }): JSX.Element {
  switch (tip.action) {
    case 'enable-voice':
      return (
        <div className="flex flex-col items-center gap-2.5">
          <div className="flex size-14 items-center justify-center rounded-full bg-foreground text-background">
            <Mic className="size-5" />
          </div>
          {/* Animated waveform — purely decorative, signals "voice" without copy */}
          <div className="flex h-6 items-center justify-center gap-1" aria-hidden="true">
            {WAVEFORM_BAR_HEIGHTS.map((height, i) => (
              <span
                key={i}
                className="block w-[3px] rounded-[2px] bg-foreground/60 animate-waveform"
                style={{ height: `${height}%`, animationDelay: `${i * 0.1}s` }}
              />
            ))}
          </div>
        </div>
      )
    case 'open-agent-status-release-notes':
      return <AgentStatusSidebarVisual />
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
  const modalData = useAppStore((s) => s.modalData)
  const isOpen = activeModal === 'feature-tips'
  const currentTip = getFeatureTipForModal({
    modalData,
    seenTipIds,
    settings
  })

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

    runFeatureTipPrimaryAction(currentTip, {
      closeModal,
      markFeatureTipsSeen,
      openSettingsPage,
      openSettingsTarget,
      openUrl: (url) => window.api.shell.openUrl(url),
      settings,
      updateSettings
    })
  }

  if (!isOpen || !currentTip) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md gap-4 p-7" showCloseButton>
        <DialogHeader className="items-center gap-4 px-8 text-center sm:text-center">
          <Badge
            variant="outline"
            className="gap-1.5 px-2.5 py-1 text-[11px] uppercase tracking-[0.08em]"
          >
            <Sparkles className="size-3" />
            {currentTip.eyebrow}
          </Badge>
          <FeatureTipVisual tip={currentTip} />
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
