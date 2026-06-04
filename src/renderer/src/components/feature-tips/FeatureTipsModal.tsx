import { useEffect, useRef, useState, type JSX } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { toast } from 'sonner'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { CliFeatureTipVisual } from './CliFeatureTipVisual'
import { CliSkillSetupTerminal } from './CliSkillSetupTerminal'
import { installCliFromFeatureTip } from './feature-tip-cli-install-action'
import { getFeatureTipForModal } from './feature-tip-modal-state'
import {
  getOrcaCliFeatureTipTelemetrySource,
  trackOrcaCliFeatureTipSetupClicked,
  trackOrcaCliFeatureTipSetupResult
} from './feature-tip-telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'

const WAVEFORM_BAR_HEIGHTS = [30, 60, 90, 70, 100, 50, 80, 35, 65]

function WorktreePromptTerm({ children }: { children: string }): JSX.Element {
  return (
    <span className="rounded-sm bg-foreground/10 px-1 py-0.5 font-medium text-foreground">
      {children}
    </span>
  )
}

function FeatureTipVisual({ tip }: { tip: FeatureTip }): JSX.Element {
  if (tip.action === 'setup-cli') {
    return <CliFeatureTipVisual />
  }

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
  }
}

function FeatureTipActions({
  currentTip,
  primaryBusy,
  onPrimaryAction,
  onSkip,
  showSkip = true,
  fullWidth = false
}: {
  currentTip: FeatureTip
  primaryBusy: boolean
  onPrimaryAction: () => void
  onSkip: () => void
  showSkip?: boolean
  fullWidth?: boolean
}): JSX.Element {
  return (
    <>
      {showSkip ? (
        <Button variant="ghost" onClick={onSkip} disabled={primaryBusy}>
          Maybe Later
        </Button>
      ) : null}
      <Button
        className={fullWidth ? 'w-full' : undefined}
        onClick={onPrimaryAction}
        disabled={primaryBusy}
      >
        {primaryBusy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Installing...
          </>
        ) : (
          currentTip.ctaLabel
        )}
      </Button>
    </>
  )
}

export default function FeatureTipsModal(): JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const seenTipIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const markFeatureTipsSeen = useAppStore((s) => s.markFeatureTipsSeen)
  const modalData = useAppStore((s) => s.modalData)
  const mountedRef = useMountedRef()
  const activeModalRef = useRef(activeModal)
  const setupRequestIdRef = useRef(0)
  const [primaryBusy, setPrimaryBusy] = useState(false)
  const [skillTerminalOpen, setSkillTerminalOpen] = useState(false)
  const isOpen = activeModal === 'feature-tips'
  const currentTip = getFeatureTipForModal({
    cliInstalled: true,
    modalData,
    seenTipIds,
    featureInteractions,
    settings
  })

  useEffect(() => {
    activeModalRef.current = activeModal
  }, [activeModal])

  const markCurrentTipSeen = (): void => {
    if (currentTip) {
      markFeatureTipsSeen([currentTip.id])
    }
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      setupRequestIdRef.current += 1
      markCurrentTipSeen()
      setSkillTerminalOpen(false)
      setPrimaryBusy(false)
      closeModal()
    }
  }

  const handleSkip = (): void => {
    setupRequestIdRef.current += 1
    markCurrentTipSeen()
    setSkillTerminalOpen(false)
    setPrimaryBusy(false)
    closeModal()
  }

  const openCliSettings = (): void => {
    openSettingsTarget({ pane: 'general', repoId: null, sectionId: 'cli' })
    openSettingsPage()
  }

  const enableOrchestrationSkillSetup = (): void => {
    localStorage.setItem(ORCHESTRATION_ENABLED_STORAGE_KEY, '1')
    localStorage.removeItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY)
    notifyOrchestrationSetupStateChanged()
  }

  const handlePrimaryAction = async (): Promise<void> => {
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
        break
      }
      case 'setup-cli': {
        const setupRequestId = setupRequestIdRef.current + 1
        setupRequestIdRef.current = setupRequestId
        // Why: this modal is lazily mounted; closing it does not unmount the
        // component, so async install results must not reopen UI after dismissal.
        const canApplySetupResult = (): boolean =>
          mountedRef.current &&
          activeModalRef.current === 'feature-tips' &&
          setupRequestIdRef.current === setupRequestId
        const telemetrySource = getOrcaCliFeatureTipTelemetrySource(modalData.source)
        trackOrcaCliFeatureTipSetupClicked(telemetrySource)
        setPrimaryBusy(true)
        try {
          const result = await installCliFromFeatureTip(() => window.api.cli.install())
          if (result.kind === 'installed') {
            trackOrcaCliFeatureTipSetupResult(telemetrySource, 'installed')
            if (!canApplySetupResult()) {
              return
            }
            enableOrchestrationSkillSetup()
            toast.success('Registered `orca` in PATH.')
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult(telemetrySource, 'needs_attention')
          if (!canApplySetupResult()) {
            return
          }
          toast.warning('Orca CLI needs attention', {
            description: result.status.detail ?? 'Open Settings to finish CLI setup.'
          })
          closeModal()
          openCliSettings()
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to install Orca CLI.'
          if (
            import.meta.env.DEV &&
            message.includes('Development mode uses a generated launcher for validation only')
          ) {
            trackOrcaCliFeatureTipSetupResult(telemetrySource, 'dev_preview')
            if (!canApplySetupResult()) {
              return
            }
            enableOrchestrationSkillSetup()
            toast.info('Development preview: opening skills setup terminal.')
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult(telemetrySource, 'failed')
          if (canApplySetupResult()) {
            toast.error(message)
          }
        } finally {
          if (canApplySetupResult()) {
            setPrimaryBusy(false)
          }
        }
      }
    }
  }

  if (!isOpen || !currentTip) {
    return null
  }

  if (currentTip.action === 'setup-cli') {
    return (
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        {/* Why: the CLI tip sits over terminal surfaces, so it needs a local token-mixed surface. */}
        <DialogContent
          className="!flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))] sm:max-w-4xl md:!h-[min(31rem,calc(100vh-2rem))] md:!flex-row"
          showCloseButton={!skillTerminalOpen}
        >
          <div
            className={`scrollbar-sleek flex min-h-0 min-w-0 flex-1 flex-col justify-between overflow-y-auto px-8 py-9 transition-[flex-basis] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none md:shrink-0 ${
              skillTerminalOpen ? 'basis-auto md:basis-full' : 'basis-auto md:basis-[47.5%]'
            }`}
          >
            <DialogHeader className={`${skillTerminalOpen ? 'gap-2' : 'gap-4'} text-left`}>
              <div>
                <DialogTitle
                  className={`text-3xl font-semibold leading-tight tracking-tight ${
                    skillTerminalOpen ? 'max-w-2xl' : 'max-w-[22rem]'
                  }`}
                >
                  {currentTip.title}
                </DialogTitle>
                <DialogDescription className="mt-3 max-w-2xl text-sm leading-relaxed">
                  {currentTip.description}
                </DialogDescription>
                <div
                  aria-hidden={skillTerminalOpen}
                  className={`max-w-sm space-y-2 overflow-hidden rounded-md border text-sm leading-relaxed text-muted-foreground transition-[max-height,opacity,transform,margin,padding,border-color] duration-300 ease-out motion-reduce:transition-none ${
                    skillTerminalOpen
                      ? 'pointer-events-none mt-0 max-h-0 -translate-y-2 border-transparent p-0 opacity-0'
                      : 'mt-3 max-h-64 translate-y-0 border-border/70 bg-muted/35 p-3 opacity-100'
                  }`}
                >
                  <p className="font-medium text-foreground">Try asking:</p>
                  <p>
                    “Split this PR into two <WorktreePromptTerm>worktrees</WorktreePromptTerm> and
                    create PRs for each.”
                  </p>
                  <p>
                    “When the agent in <WorktreePromptTerm>worktree</WorktreePromptTerm> X finishes,
                    send it the review task.”
                  </p>
                </div>
              </div>
              {skillTerminalOpen ? <CliSkillSetupTerminal /> : null}
            </DialogHeader>

            <DialogFooter className="mt-8 flex sm:justify-stretch">
              {skillTerminalOpen ? (
                <Button className="w-full" onClick={handleSkip}>
                  Done
                </Button>
              ) : (
                <FeatureTipActions
                  currentTip={currentTip}
                  primaryBusy={primaryBusy}
                  onPrimaryAction={() => void handlePrimaryAction()}
                  onSkip={handleSkip}
                  showSkip={false}
                  fullWidth
                />
              )}
            </DialogFooter>
          </div>
          <div
            className={`min-h-0 min-w-0 shrink-0 overflow-hidden transition-[flex-basis,max-height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
              skillTerminalOpen
                ? 'pointer-events-none max-h-0 basis-0 md:max-h-none md:basis-0'
                : 'max-h-[40rem] basis-auto md:basis-[52.5%]'
            }`}
          >
            <div
              className={`h-full transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none md:w-[29.4rem] ${
                skillTerminalOpen ? 'translate-x-full opacity-0' : 'translate-x-0 opacity-100'
              }`}
            >
              {skillTerminalOpen ? null : <FeatureTipVisual tip={currentTip} />}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md gap-4 p-7" showCloseButton>
        <DialogHeader className="items-center gap-4 px-8 text-center sm:text-center">
          <FeatureTipVisual tip={currentTip} />
          <DialogTitle className="text-2xl font-semibold tracking-tight">
            {currentTip.title}
          </DialogTitle>
          <DialogDescription className="max-w-sm text-sm leading-relaxed">
            {currentTip.description}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="sm:justify-center">
          <FeatureTipActions
            currentTip={currentTip}
            primaryBusy={primaryBusy}
            onPrimaryAction={() => void handlePrimaryAction()}
            onSkip={handleSkip}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
