import { useEffect, useState, type JSX } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { toast } from 'sonner'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { Button } from '@/components/ui/button'
import { AgentsOrchestrationVisual } from '@/components/feature-wall/AgentsOrchestrationVisual'
import {
  ORCHESTRATION_CLI_COMMAND_LOOP_MS,
  ORCHESTRATION_CLI_COMMAND_TIMINGS_MS
} from '@/components/feature-wall/agents-orchestration/orchestration-types'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import { ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
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
import { installCliFromFeatureTip } from './feature-tip-cli-install-action'
import { getFeatureTipForModal } from './feature-tip-modal-state'
import {
  getOrcaCliFeatureTipTelemetrySource,
  trackOrcaCliFeatureTipSetupClicked,
  trackOrcaCliFeatureTipSetupResult
} from './feature-tip-telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'

const WAVEFORM_BAR_HEIGHTS = [30, 60, 90, 70, 100, 50, 80, 35, 65]
const CLI_AGENT_COMMANDS = [
  'orca worktree create --name auth-pr-1',
  'orca worktree create --name auth-pr-2',
  'orca orchestration dispatch --task pr1 --to w1',
  'orca orchestration dispatch --task pr2 --to w2'
]

function CliFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const [visibleCommandCount, setVisibleCommandCount] = useState(
    reducedMotion ? CLI_AGENT_COMMANDS.length : 0
  )

  useEffect(() => {
    if (reducedMotion) {
      setVisibleCommandCount(CLI_AGENT_COMMANDS.length)
      return
    }

    let cancelled = false
    const timeouts: number[] = []
    const later = (fn: () => void, ms: number): void => {
      timeouts.push(window.setTimeout(() => !cancelled && fn(), ms))
    }

    // Why: terminal lines mirror the orchestration tour beat timings so the
    // shell shows each command as the parent agent runs it.
    const runOnce = (): void => {
      setVisibleCommandCount(0)
      ORCHESTRATION_CLI_COMMAND_TIMINGS_MS.forEach((ms, index) => {
        later(() => setVisibleCommandCount(index + 1), ms)
      })
      later(runOnce, ORCHESTRATION_CLI_COMMAND_LOOP_MS)
    }

    runOnce()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  return (
    <div
      className="relative flex min-h-[27rem] flex-col overflow-hidden bg-muted/60 px-6 py-7"
      aria-hidden="true"
    >
      <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-background/55 to-transparent" />
      <div className="relative rounded-lg border border-border/70 bg-card/95 shadow-xs">
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <span className="size-2 rounded-full bg-muted-foreground/35" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="space-y-1.5 px-3 py-3 font-mono text-[10.5px] leading-[1.35] text-foreground">
          <div className="truncate text-muted-foreground">
            <span className="mr-1.5 text-foreground">●</span>Claude Code session started
          </div>
          {CLI_AGENT_COMMANDS.map((command, index) => {
            const isVisible = index < visibleCommandCount
            const isCurrentLine = isVisible && index === visibleCommandCount - 1
            return (
              <div
                key={command}
                className={`truncate ${isVisible ? 'animate-cli-tip-command-line' : 'invisible'}`}
              >
                <span className="text-amber-600">&gt; </span>
                <span>{command}</span>
                {isCurrentLine ? (
                  <span className="animate-cli-tip-caret ml-0.5 inline-block h-3 w-1 translate-y-0.5 rounded-sm bg-foreground/70" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      <div className="cli-tip-orchestration-frame relative mt-5 flex h-[17rem] items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-background/80 px-5 shadow-xs">
        <div className="origin-center">
          <AgentsOrchestrationVisual
            activeStepId="orchestration"
            reducedMotion={reducedMotion}
            widthPx={350}
            heightPx={252}
            orchestrationCreatedChildCount={Math.min(visibleCommandCount, 2)}
            orchestrationLoopMs={ORCHESTRATION_CLI_COMMAND_LOOP_MS}
            orchestrationShowResponseBeats={false}
          />
        </div>
      </div>
    </div>
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

  const markCurrentTipSeen = (): void => {
    if (currentTip) {
      markFeatureTipsSeen([currentTip.id])
    }
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      markCurrentTipSeen()
      setSkillTerminalOpen(false)
      closeModal()
    }
  }

  const handleSkip = (): void => {
    markCurrentTipSeen()
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
        const telemetrySource = getOrcaCliFeatureTipTelemetrySource(modalData.source)
        trackOrcaCliFeatureTipSetupClicked(telemetrySource)
        setPrimaryBusy(true)
        try {
          const result = await installCliFromFeatureTip(() => window.api.cli.install())
          if (result.kind === 'installed') {
            trackOrcaCliFeatureTipSetupResult(telemetrySource, 'installed')
            enableOrchestrationSkillSetup()
            if (!mountedRef.current) {
              return
            }
            toast.success('Registered `orca` in PATH.')
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult(telemetrySource, 'needs_attention')
          if (!mountedRef.current) {
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
            enableOrchestrationSkillSetup()
            if (!mountedRef.current) {
              return
            }
            toast.info('Development preview: opening skills setup terminal.')
            setSkillTerminalOpen(true)
            return
          }

          trackOrcaCliFeatureTipSetupResult(telemetrySource, 'failed')
          if (mountedRef.current) {
            toast.error(message)
          }
        } finally {
          if (mountedRef.current) {
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
        <DialogContent className="grid gap-0 overflow-hidden p-0 sm:max-w-4xl md:grid-cols-[minmax(22rem,0.95fr)_minmax(26rem,1.05fr)]">
          <div className="flex min-h-[27rem] flex-col justify-between px-8 py-9">
            <DialogHeader className="gap-4 text-left">
              <div className="space-y-3">
                <DialogTitle className="max-w-[22rem] text-3xl font-semibold leading-tight tracking-tight">
                  {currentTip.title}
                </DialogTitle>
                <DialogDescription className="max-w-sm text-sm leading-relaxed">
                  {currentTip.description}
                </DialogDescription>
                {skillTerminalOpen ? null : (
                  <div className="max-w-sm space-y-2 rounded-md border border-border/70 bg-muted/35 p-3 text-sm leading-relaxed text-muted-foreground">
                    <p className="font-medium text-foreground">Try asking:</p>
                    <p>“Split this PR into two workspaces and create PRs for each.”</p>
                    <p>“When the agent in workspace X finishes, send it the review task.”</p>
                  </div>
                )}
              </div>
              {skillTerminalOpen ? (
                <OnboardingInlineCommandTerminal
                  command={ORCA_CLI_ORCHESTRATION_SKILL_INSTALL_COMMAND}
                  title="Skill setup"
                  ariaLabel="Orca CLI and orchestration skill install terminal"
                  description="Press Enter to install the Orca CLI and orchestration skills for your agents."
                  terminalHeightPx={150}
                  terminalTopMarginPx={4}
                  descriptionPaddingClassName="px-4 py-2"
                  autoScrollIntoView={false}
                  worktreeId="feature-tip-cli-skills-terminal"
                />
              ) : null}
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
          <FeatureTipVisual tip={currentTip} />
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
