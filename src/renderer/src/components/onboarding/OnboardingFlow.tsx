import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, CornerDownLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isEditableTarget } from '@/lib/editable-target'
import { getScreenSubmitModifierLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { OnboardingState } from '../../../../shared/types'
import { AgentStep } from './AgentStep'
import { ThemeStep } from './ThemeStep'
import { NotificationStep } from './NotificationStep'
import { AgentFeatureSetupStep } from './AgentFeatureSetupStep'
import { IntegrationsStep } from './IntegrationsStep'
import { RepoStep } from './RepoStep'
import { OnboardingTourStep } from './OnboardingTourStep'
import { STEPS, useOnboardingFlow } from './use-onboarding-flow'
import { OnboardingSkipConfirmationDialog } from './OnboardingSkipConfirmationDialog'
import logo from '../../../../../resources/logo.svg'

const stepCopy = {
  agent: {
    title: 'Pick your default agent',
    subtitle:
      "Orca works with every CLI agent. Choose the one you'll reach for most. Switch any time."
  },
  theme: {
    title: 'Make it feel like home',
    subtitle: 'Pick the look you want to stare at for hours.'
  },
  notifications: {
    title: 'Set up notifications',
    subtitle: 'Orca will notify you know when agents are done or need help.'
  },
  agentSetup: {
    title: 'Set up Orca for agents',
    subtitle: 'Turn on advanced Orca capabilities for agents.'
  },
  integrations: {
    title: 'Connect your task sources',
    subtitle: 'Connect GitHub or Linear to:'
  },
  tour: {
    title: 'Explore Orca',
    subtitle: ''
  },
  repo: {
    title: 'Point Orca at some code',
    subtitle: 'Open a folder or clone a repo to finish setup.'
  }
} as const

const stepTooltipLabels = {
  agent: 'Default Agent',
  theme: 'Appearance',
  notifications: 'Notifications',
  agentSetup: 'Agent setup',
  integrations: 'Integrations',
  tour: 'Explore Orca',
  repo: 'Create project'
} as const

type OnboardingFlowProps = {
  onboarding: OnboardingState
  onOnboardingChange: (state: OnboardingState) => void
  onSettingsDetourStart?: () => void
}

export default function OnboardingFlow({
  onboarding,
  onOnboardingChange,
  onSettingsDetourStart
}: OnboardingFlowProps): React.JSX.Element {
  const flow = useOnboardingFlow(onboarding, onOnboardingChange, { onSettingsDetourStart })
  const continueShortcutModifierLabel = getScreenSubmitModifierLabel()
  const { currentStep, stepIndex, busyLabel } = flow
  const copy = stepCopy[currentStep.id]
  const isTourStep = currentStep.id === 'tour'
  const tourStarted = flow.tourStarted
  const isInlineTourRunning = isTourStep && tourStarted
  const shouldShowFooter = !isInlineTourRunning
  const shouldShowSkipToProjectSetup = currentStep.id !== 'repo'
  const shouldShowStepHeading = !isInlineTourRunning
  const shouldShowFooterBusy = Boolean(busyLabel) && currentStep.id !== 'agentSetup'
  const footerPrimaryLabel =
    currentStep.id === 'agentSetup' ? 'Continue' : (busyLabel ?? 'Continue')
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false)
  const skipConfirmAdvancedViaRef = useRef<'button' | 'keyboard'>('button')
  const {
    next: flowNext,
    openFolder: flowOpenFolder,
    continueWithExistingProject: flowContinueWithExistingProject,
    skipTourToRepo: flowSkipTourToRepo,
    dismissOnboarding: flowDismissOnboarding
  } = flow

  const requestSkipConfirmation = useCallback(
    (advancedVia: 'button' | 'keyboard') => {
      if (busyLabel || skipConfirmOpen) {
        return
      }
      skipConfirmAdvancedViaRef.current = advancedVia
      setSkipConfirmOpen(true)
    },
    [busyLabel, skipConfirmOpen]
  )

  const confirmSkipOnboarding = useCallback(() => {
    const advancedVia = skipConfirmAdvancedViaRef.current
    setSkipConfirmOpen(false)
    void flowDismissOnboarding(advancedVia)
  }, [flowDismissOnboarding])

  // Why: depend on stable callbacks + step id only so the listener doesn't
  // re-bind on every render of the parent (flow object identity changes).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: don't hijack Enter / Cmd+Enter while the user is typing into the
      // clone-URL input or any other editable field on a step.
      if (isEditableTarget(event.target)) {
        return
      }
      // Why: onboarding continue is screen-local submit behavior, not a
      // user-configurable app command.
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      if (currentStep.id === 'tour' && tourStarted) {
        return
      }
      event.preventDefault()
      if (currentStep.id === 'tour') {
        if (!tourStarted) {
          void flowSkipTourToRepo()
        }
        return
      }
      if (currentStep.id === 'repo') {
        if (flow.hasExistingProject) {
          void flowContinueWithExistingProject('keyboard')
        } else {
          void flowOpenFolder()
        }
      } else {
        void flowNext('keyboard')
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    currentStep.id,
    flow.hasExistingProject,
    flowContinueWithExistingProject,
    flowNext,
    flowOpenFolder,
    flowSkipTourToRepo,
    tourStarted
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || skipConfirmOpen) {
        return
      }
      event.preventDefault()
      requestSkipConfirmation('keyboard')
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [requestSkipConfirmation, skipConfirmOpen])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/50 p-4 text-foreground backdrop-blur-[2px]"
      data-onboarding-overlay
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return
        }
        const target = event.target
        if (!(target instanceof Element) || target.closest('[data-onboarding-modal]')) {
          return
        }
        requestSkipConfirmation('button')
      }}
    >
      <div
        className="absolute inset-x-0 top-0 h-8"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      <section
        role="dialog"
        aria-label="Orca onboarding"
        aria-modal="true"
        data-onboarding-modal
        className={cn(
          'relative flex h-[calc(100vh-2rem)] max-h-[960px] min-h-0 w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] transition-[max-width] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          isInlineTourRunning ? 'max-w-[1180px]' : 'max-w-[1100px]'
        )}
      >
        <div className="relative flex h-full min-h-0 flex-col px-6 pb-6 pt-8 sm:px-8 sm:pb-8 sm:pt-9">
          <div className="flex items-center gap-3 text-base font-semibold tracking-tight">
            <img
              src={logo}
              alt=""
              aria-hidden="true"
              className="h-7 w-auto shrink-0 invert dark:invert-0"
            />
            <span>Orca</span>
          </div>

          <div
            className={cn(
              'flex items-center gap-2 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              isInlineTourRunning ? 'mt-7' : 'mt-10'
            )}
          >
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              {STEPS.map((step, idx) => {
                const isActive = idx === stepIndex
                const isDone = idx < stepIndex
                return (
                  <Tooltip key={step.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          // Why: the visible bars stay 4px tall, but the invisible
                          // hit area makes hover/click/tooltip targeting reliable.
                          'relative h-1 rounded-full outline-none transition-all duration-300 before:absolute before:-inset-y-2 before:-inset-x-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                          isActive
                            ? 'w-10 bg-foreground'
                            : isDone
                              ? 'w-6 bg-muted-foreground/70 hover:bg-foreground/80'
                              : 'w-6 bg-muted-foreground/25 hover:bg-muted-foreground/45'
                        )}
                        aria-label={`Go to onboarding step ${step.stepNumber}: ${stepCopy[step.id].title}`}
                        aria-current={isActive ? 'step' : undefined}
                        onClick={() => flow.jumpToStep(idx)}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} style={{ zIndex: 110 }}>
                      {stepTooltipLabels[step.id]}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </TooltipProvider>
            <span className="ml-3 text-xs font-medium text-muted-foreground">
              {stepIndex + 1} of {STEPS.length}
            </span>
            {isInlineTourRunning ? (
              <h1 className="ml-5 text-[34px] font-semibold leading-[1.15] tracking-tight text-foreground">
                {stepTooltipLabels.tour}
              </h1>
            ) : null}
          </div>

          {shouldShowStepHeading ? (
            <div className="mt-8 shrink-0">
              {stepIndex === 0 && (
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Welcome to Orca
                </div>
              )}
              <h1 className="text-[34px] font-semibold leading-[1.15] tracking-tight text-foreground">
                {copy.title}
              </h1>
              {copy.subtitle ? (
                <p
                  className={cn(
                    'mt-3 text-[15px] leading-relaxed text-muted-foreground',
                    currentStep.id === 'agentSetup' ? 'max-w-none' : 'max-w-[58ch]'
                  )}
                >
                  {copy.subtitle}
                </p>
              ) : null}
            </div>
          ) : null}

          <div
            className={cn(
              'min-h-0 flex-1 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              // Why: long setup output should scroll inside the step so the footer
              // actions stay anchored across every onboarding page.
              isInlineTourRunning
                ? 'mt-7 overflow-hidden'
                : cn(
                    'scrollbar-sleek overflow-y-auto pr-1',
                    currentStep.id === 'agentSetup' ? 'mt-4' : 'mt-10'
                  )
            )}
          >
            {currentStep.id === 'agent' && (
              <AgentStep
                selectedAgent={flow.selectedAgent}
                onSelect={flow.setSelectedAgent}
                detectedSet={flow.detectedSet}
                isDetecting={flow.isDetectingAgents}
              />
            )}
            {currentStep.id === 'theme' && (
              <ThemeStep
                theme={flow.theme}
                onThemeChange={flow.setTheme}
                settings={flow.settings}
                updateSettings={flow.updateSettings}
              />
            )}
            {currentStep.id === 'notifications' && (
              <NotificationStep settings={flow.settings} updateSettings={flow.updateSettings} />
            )}
            {currentStep.id === 'agentSetup' && (
              <AgentFeatureSetupStep
                featureSetup={flow.featureSetupSelection}
                onFeatureSetupChange={flow.setFeatureSetupSelection}
                featureSetupCommand={flow.featureSetupTerminalCommand}
                featureSetupCommandSelection={flow.featureSetupTerminalSelection}
                setupBusyLabel={currentStep.id === 'agentSetup' ? busyLabel : null}
                onStartFeatureSetup={() => void flow.startFeatureSetup()}
              />
            )}
            {currentStep.id === 'integrations' && <IntegrationsStep />}
            {currentStep.id === 'tour' && (
              <OnboardingTourStep
                tourStarted={flow.tourStarted}
                busyLabel={busyLabel}
                onStartTour={flow.startTour}
                onCompleteTour={flow.completeTour}
                onExitTour={flow.exitTour}
                onTourDepthSummaryChange={flow.recordTourDepthSummary}
              />
            )}
            {currentStep.id === 'repo' && (
              <RepoStep
                cloneUrl={flow.cloneUrl}
                onCloneUrlChange={flow.setCloneUrl}
                onOpenFolder={() => void flow.openFolder()}
                onOpenServerFolder={(kind) => void flow.openFolder(kind)}
                onClone={() => void flow.clone()}
                onOpenSshSettings={() => void flow.openSshSettings()}
                serverPath={flow.serverPath}
                onServerPathChange={flow.setServerPath}
                cloneDestination={flow.cloneDestination}
                onCloneDestinationChange={flow.setCloneDestination}
                workspaceDir={flow.settings?.workspaceDir ?? ''}
                runtimeActive={Boolean(flow.settings?.activeRuntimeEnvironmentId?.trim())}
                busyLabel={flow.busyLabel}
                error={flow.error}
              />
            )}
          </div>

          {shouldShowFooter && (
            <footer className="mt-6 flex flex-none items-center justify-between border-t border-border pt-5">
              {shouldShowSkipToProjectSetup ? (
                <button
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground"
                  disabled={Boolean(busyLabel)}
                  onClick={() => void flow.skipToRepo()}
                >
                  Skip to project setup
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {stepIndex > 0 && (
                  <button
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-60"
                    disabled={Boolean(busyLabel)}
                    onClick={flow.back}
                  >
                    <ChevronLeft className="size-4" />
                    Back
                  </button>
                )}
                {(currentStep.id !== 'repo' || flow.hasExistingProject) && (
                  <button
                    className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    aria-busy={shouldShowFooterBusy}
                    disabled={Boolean(busyLabel)}
                    onClick={() => {
                      if (isTourStep) {
                        void flow.skipTourToRepo()
                        return
                      }
                      if (currentStep.id === 'repo') {
                        void flow.continueWithExistingProject()
                        return
                      }
                      void flow.next()
                    }}
                  >
                    {shouldShowFooterBusy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {footerPrimaryLabel}
                    <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
                      <span>{continueShortcutModifierLabel}</span>
                      <CornerDownLeft className="size-3" />
                    </span>
                  </button>
                )}
              </div>
            </footer>
          )}
        </div>
      </section>
      <OnboardingSkipConfirmationDialog
        open={skipConfirmOpen}
        onOpenChange={setSkipConfirmOpen}
        onSkip={confirmSkipOnboarding}
      />
    </div>
  )
}
