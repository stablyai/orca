import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { isEditableTarget } from '@/lib/editable-target'
import { getScreenSubmitModifierLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { OnboardingState } from '../../../../shared/types'
import { AgentStep } from './AgentStep'
import { ThemeStep } from './ThemeStep'
import { NotificationStep } from './NotificationStep'
import { IntegrationsStep } from './IntegrationsStep'
import { useOnboardingFlow } from './use-onboarding-flow'
import { OnboardingSkipConfirmationDialog } from './OnboardingSkipConfirmationDialog'
import { OnboardingFooter } from './OnboardingFooter'
import { shouldRequestOnboardingSkipConfirmation } from './onboarding-dismiss-target'
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
  integrations: {
    title: 'Set up GitHub tasks',
    subtitle: 'Install the GitHub CLI to:'
  }
} as const

const stepTooltipLabels = {
  agent: 'Default Agent',
  theme: 'Appearance',
  notifications: 'Notifications',
  integrations: 'Integrations'
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
  const shouldShowSkipToProjectSetup = currentStep.id !== 'notifications'
  const shouldShowFooterBusy = Boolean(busyLabel)
  const footerPrimaryLabel =
    busyLabel ?? (currentStep.id === 'notifications' ? 'Add your first project' : 'Continue')
  const canDismissCurrentStep = currentStep.id !== 'notifications'
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false)
  const skipConfirmAdvancedViaRef = useRef<'button' | 'keyboard'>('button')
  const { next: flowNext, dismissOnboarding: flowDismissOnboarding } = flow

  const requestSkipConfirmation = useCallback(
    (advancedVia: 'button' | 'keyboard') => {
      // Why: the final notifications step hands off to Add Project, so all
      // dismiss paths are disabled there, not just the visible Skip button.
      if (!canDismissCurrentStep || busyLabel || skipConfirmOpen) {
        return
      }
      skipConfirmAdvancedViaRef.current = advancedVia
      setSkipConfirmOpen(true)
    },
    [busyLabel, canDismissCurrentStep, skipConfirmOpen]
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
      event.preventDefault()
      void flowNext('keyboard')
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [flowNext])

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
        if (!shouldRequestOnboardingSkipConfirmation(event)) {
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
        ref={flow.setLifecycleRootRef}
        role="dialog"
        aria-label="Orca onboarding"
        aria-modal="true"
        data-onboarding-modal
        className={cn(
          'relative flex h-[calc(100vh-2rem)] max-h-[960px] min-h-0 w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] transition-[max-width] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          'max-w-[1100px]'
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

          <div className="mt-10 flex items-center gap-2 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none">
            <TooltipProvider delayDuration={0} skipDelayDuration={0}>
              {flow.visibleSteps.map(({ step, index: realStepIndex }, visibleIdx) => {
                const isActive = realStepIndex === stepIndex
                const isDone = realStepIndex < stepIndex
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
                        aria-label={`Go to onboarding step ${visibleIdx + 1}: ${stepCopy[step.id].title}`}
                        aria-current={isActive ? 'step' : undefined}
                        onClick={() => flow.jumpToStep(realStepIndex)}
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
              {flow.visibleStepIndex + 1} of {flow.visibleSteps.length}
            </span>
          </div>

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
              <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-muted-foreground">
                {copy.subtitle}
              </p>
            ) : null}
          </div>

          <div
            className={cn(
              'min-h-0 flex-1 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              // Why: long setup output should scroll inside the step so the footer
              // actions stay anchored across every onboarding page.
              cn('scrollbar-sleek overflow-y-auto pr-1', 'mt-10')
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
            {currentStep.id === 'integrations' && <IntegrationsStep />}
          </div>

          <OnboardingFooter
            shouldShowSkipToProjectSetup={shouldShowSkipToProjectSetup}
            busyLabel={busyLabel}
            onSkipToRepo={() => void flow.skipToRepo()}
            stepIndex={stepIndex}
            onBack={flow.nestedScan ? flow.cancelNested : flow.back}
            showPrimary
            primaryBusy={shouldShowFooterBusy}
            primaryLabel={footerPrimaryLabel}
            shortcutModifierLabel={continueShortcutModifierLabel}
            onPrimary={() => void flow.next()}
          />
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
