import { OnboardingLanguageSwitcher } from './OnboardingLanguageSwitcher'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { isEditableTarget } from '@/lib/editable-target'
import { getScreenSubmitModifierLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { OnboardingState } from '../../../../shared/onboarding-state-types'
import { AgentStep } from './AgentStep'
import { ThemeStep } from './ThemeStep'
import { NotificationStep } from './NotificationStep'
import { IntegrationsStep } from './IntegrationsStep'
import { WindowsTerminalStep } from './WindowsTerminalStep'
import { useOnboardingFlow } from './use-onboarding-flow'
import { OnboardingSkipConfirmationDialog } from './OnboardingSkipConfirmationDialog'
import { OnboardingFooter } from './OnboardingFooter'
import { shouldRequestOnboardingSkipConfirmation } from './onboarding-dismiss-target'
import logo from '../../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'
import { useScrollEdgeFades } from '@/lib/use-scroll-edge-fades'
import { AgentSurfaceStep } from './AgentSurfaceStep'
import { stepCopy, stepTooltipLabels } from './onboarding-step-copy'

type OnboardingFlowProps = {
  onboarding: OnboardingState
  onOnboardingChange: (state: OnboardingState) => void
}

export default function OnboardingFlow({
  onboarding,
  onOnboardingChange
}: OnboardingFlowProps): React.JSX.Element {
  const flow = useOnboardingFlow(onboarding, onOnboardingChange)
  const stepFades = useScrollEdgeFades<HTMLDivElement>()
  const continueShortcutModifierLabel = getScreenSubmitModifierLabel()
  const { currentStep, stepIndex, busyLabel } = flow
  const copy =
    currentStep.id === 'agent' && flow.agentSurface === 'chat'
      ? stepCopy.agent_chat
      : stepCopy[currentStep.id]
  const shouldShowSkipToProjectSetup = currentStep.id !== 'notifications'
  const shouldShowFooterBusy = Boolean(busyLabel)
  const footerPrimaryLabel =
    busyLabel ??
    (currentStep.id === 'notifications'
      ? translate('components.onboarding.flow.actions.addFirstProject', 'Add your first project')
      : translate('components.onboarding.flow.actions.continue', 'Continue'))
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false)
  const [skipConfirmOpen, setSkipConfirmOpen] = useState(false)
  const skipConfirmAdvancedViaRef = useRef<'button' | 'keyboard'>('button')
  const { next: flowNext, dismissOnboarding: flowDismissOnboarding } = flow

  const requestSkipConfirmation = useCallback(
    (advancedVia: 'button' | 'keyboard') => {
      if (busyLabel || skipConfirmOpen || languagePickerOpen) {
        return
      }
      skipConfirmAdvancedViaRef.current = advancedVia
      setSkipConfirmOpen(true)
    },
    [busyLabel, skipConfirmOpen, languagePickerOpen]
  )

  const confirmSkipOnboarding = useCallback(() => {
    const advancedVia = skipConfirmAdvancedViaRef.current
    setSkipConfirmOpen(false)
    void flowDismissOnboarding(advancedVia)
  }, [flowDismissOnboarding])

  // Depend on stable callbacks/step ID so the changing flow object cannot churn the key listener.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (languagePickerOpen || skipConfirmOpen) {
        return
      }
      // Do not submit while typing in clone URL or another editable field.
      if (isEditableTarget(event.target)) {
        return
      }
      // Continue uses the screen submit shortcut rather than configurable app-command bindings.
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      event.preventDefault()
      void flowNext('keyboard')
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [flowNext, languagePickerOpen, skipConfirmOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || skipConfirmOpen || languagePickerOpen) {
        return
      }
      event.preventDefault()
      requestSkipConfirmation('keyboard')
    }
    addAppKeyListener('keydown', onKeyDown)
    return () => removeAppKeyListener('keydown', onKeyDown)
  }, [requestSkipConfirmation, skipConfirmOpen, languagePickerOpen])

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-black/50 p-4 text-foreground"
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
          aria-label={translate(
            'auto.components.onboarding.OnboardingFlow.277ba45540',
            'Orca onboarding'
          )}
          aria-modal="true"
          data-onboarding-modal
          className={cn(
            'relative flex h-[calc(100vh-2rem)] max-h-[960px] min-h-0 w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] transition-[max-width] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            'max-w-[1100px]'
          )}
        >
          <div className="relative flex h-full min-h-0 flex-col px-6 pb-6 pt-8 sm:px-8 sm:pb-8 sm:pt-9">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-base font-semibold tracking-tight">
                <img
                  src={logo}
                  alt=""
                  aria-hidden="true"
                  className="h-7 w-auto shrink-0 invert dark:invert-0"
                />
                <span>
                  {translate('auto.components.onboarding.OnboardingFlow.a249f81538', 'Orca')}
                </span>
              </div>
              <OnboardingLanguageSwitcher
                open={languagePickerOpen}
                onOpenChange={setLanguagePickerOpen}
              />
            </div>

            <div className="mt-10 flex items-center gap-2 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none">
              {flow.progressSteps.map(({ step, index: realStepIndex }, progressIdx) => {
                const isActive = realStepIndex === stepIndex
                const isDone = realStepIndex < stepIndex
                const stepTooltipLabel = stepTooltipLabels[step.id].value
                return (
                  <Tooltip key={step.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          // Expand the invisible hit area while keeping the stepper bars 4px tall.
                          'relative h-1 rounded-full outline-none transition-all duration-300 before:absolute before:-inset-y-2 before:-inset-x-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                          isActive
                            ? 'w-10 bg-foreground'
                            : isDone
                              ? 'w-6 bg-muted-foreground/70 hover:bg-foreground/80'
                              : 'w-6 bg-muted-foreground/25 hover:bg-muted-foreground/45'
                        )}
                        aria-label={translate(
                          'auto.components.onboarding.OnboardingFlow.adaa0aa627',
                          'Go to onboarding step {{value0}}: {{value1}}',
                          { value0: progressIdx + 1, value1: stepTooltipLabel }
                        )}
                        aria-current={isActive ? 'step' : undefined}
                        onClick={() => flow.jumpToStep(realStepIndex)}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8} style={{ zIndex: 110 }}>
                      {stepTooltipLabel}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
              <span className="ml-3 text-xs font-medium text-muted-foreground">
                {translate(
                  'auto.components.onboarding.OnboardingFlow.stepOfTotal',
                  '{{current}} of {{total}}',
                  { current: flow.progressStepIndex + 1, total: flow.progressSteps.length }
                )}
              </span>
            </div>

            <div className="mt-8 shrink-0">
              {stepIndex === 0 && (
                <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  {translate(
                    'auto.components.onboarding.OnboardingFlow.1b5e182e9f',
                    'Welcome to Orca'
                  )}
                </div>
              )}
              <h1 className="text-[34px] font-semibold leading-[1.15] tracking-tight text-foreground">
                {copy.title}
              </h1>
              {copy.subtitle ? (
                <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
                  {copy.subtitle}
                </p>
              ) : null}
            </div>

            <div
              ref={stepFades.ref}
              className={cn(
                'min-h-0 flex-1 transition-[margin-top] duration-[760ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                // Agent permissions stay outside the capped grid scroll; other steps use the outer scroller.
                currentStep.id === 'agent'
                  ? 'mt-10 flex flex-col overflow-hidden'
                  : cn('scrollbar-sleek overflow-y-auto pr-1', 'mt-10', stepFades.className)
              )}
            >
              {currentStep.id === 'agent_surface' && (
                <AgentSurfaceStep
                  agentSurface={flow.agentSurface}
                  onSelect={flow.setAgentSurface}
                  noChatAgentDetected={
                    !flow.isDetectingAgents &&
                    flow.chatDetected !== null &&
                    flow.chatDetected.length === 0
                  }
                />
              )}
              {currentStep.id === 'agent' && (
                <AgentStep
                  agentSurface={flow.agentSurface}
                  onAgentSurfaceChange={flow.setAgentSurface}
                  chatAgents={flow.chatAgents}
                  chatDetected={flow.chatDetected}
                  nativeChatProviders={flow.settings?.nativeChatProviders}
                  selectedAgent={flow.selectedAgent}
                  onSelect={flow.setSelectedAgent}
                  detectedSet={flow.detectedSet}
                  isDetecting={flow.isDetectingAgents}
                  yoloPermissions={flow.yoloPermissions}
                  onYoloPermissionsChange={flow.setYoloPermissions}
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
              {currentStep.id === 'windows_terminal' && (
                <WindowsTerminalStep
                  settings={flow.settings}
                  updateSettings={flow.updateSettings}
                />
              )}
            </div>

            <OnboardingFooter
              shouldShowSkipToProjectSetup={shouldShowSkipToProjectSetup}
              busyLabel={busyLabel}
              onSkipToRepo={() => void flow.skipToRepo()}
              stepIndex={stepIndex}
              onBack={flow.back}
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
    </TooltipProvider>
  )
}
