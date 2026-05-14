import { useEffect } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isEditableTarget } from '@/lib/editable-target'
import type { OnboardingState } from '../../../../shared/types'
import { AgentStep } from './AgentStep'
import { ThemeStep } from './ThemeStep'
import { NotificationStep } from './NotificationStep'
import { RepoStep } from './RepoStep'
import { STEPS, useOnboardingFlow } from './use-onboarding-flow'
import logo from '../../../../../resources/logo.svg'

const isMac = navigator.userAgent.includes('Mac')
// Why: AGENTS.md mandates `Ctrl+Enter` style on non-Mac; bare `Ctrl↵` reads as one glyph.
const enterLabel = isMac ? '⌘↵' : 'Ctrl+Enter'

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
    title: 'Set up Orca for agents',
    subtitle:
      'Get notifications when agents need you, and choose the capabilities Orca should enable on this computer.'
  },
  repo: {
    title: 'Point Orca at some code',
    subtitle: 'Open a folder, clone a repo, or skip and add one later.'
  }
} as const

type OnboardingFlowProps = {
  onboarding: OnboardingState
  onOnboardingChange: (state: OnboardingState) => void
}

export default function OnboardingFlow({
  onboarding,
  onOnboardingChange
}: OnboardingFlowProps): React.JSX.Element {
  const flow = useOnboardingFlow(onboarding, onOnboardingChange)
  const { currentStep, stepIndex, busyLabel } = flow
  const copy = stepCopy[currentStep.id]
  const shouldShowSetupAction =
    currentStep.id === 'notifications' &&
    flow.hasSelectedFeatureSetup &&
    !flow.featureSetupTerminalCommand
  const primaryActionLabel = busyLabel ?? (shouldShowSetupAction ? 'Set up' : 'Continue')
  // Why: depend on stable callbacks + step id only so the listener doesn't
  // re-bind on every render of the parent (flow object identity changes).
  const { next: flowNext, openFolder: flowOpenFolder } = flow

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: don't hijack Enter / Cmd+Enter while the user is typing into the
      // clone-URL input or any other editable field on a step.
      if (isEditableTarget(event.target)) {
        return
      }
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (!mod || event.key !== 'Enter') {
        return
      }
      event.preventDefault()
      if (currentStep.id === 'repo') {
        void flowOpenFolder()
      } else {
        void flowNext('keyboard')
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [currentStep.id, flowNext, flowOpenFolder])

  return (
    <div className="fixed inset-0 z-[100] overflow-auto bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 dark:opacity-70"
        style={{
          background:
            'radial-gradient(60% 50% at 20% 0%, color-mix(in srgb, var(--foreground) 6%, transparent) 0%, transparent 60%), radial-gradient(45% 40% at 90% 100%, color-mix(in srgb, var(--foreground) 4%, transparent) 0%, transparent 60%)'
        }}
      />
      <div
        className="absolute inset-x-0 top-0 h-12"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-[820px] flex-col px-8 pb-10 pt-16">
        <div className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
          <div
            className="flex size-7 items-center justify-center rounded-md"
            style={{ backgroundColor: '#12181e' }}
          >
            <img src={logo} alt="Orca logo" className="size-5" />
          </div>
          <span>Orca</span>
        </div>

        <div className="mt-12 flex items-center gap-2">
          {STEPS.map((step, idx) => {
            const isActive = idx === stepIndex
            const isDone = idx < stepIndex
            return (
              <div
                key={step.id}
                className={cn(
                  'h-1 rounded-full transition-all duration-300',
                  isActive
                    ? 'w-10 bg-foreground'
                    : isDone
                      ? 'w-6 bg-muted-foreground/70'
                      : 'w-6 bg-muted'
                )}
              />
            )
          })}
          <span className="ml-3 text-xs font-medium text-muted-foreground">
            {stepIndex + 1} of {STEPS.length}
          </span>
        </div>

        <div className="mt-8">
          {stepIndex === 0 && (
            <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Welcome to Orca
            </div>
          )}
          <h1 className="text-[34px] font-semibold leading-[1.15] tracking-tight text-foreground">
            {copy.title}
          </h1>
          <p className="mt-3 max-w-[58ch] text-[15px] leading-relaxed text-muted-foreground">
            {copy.subtitle}
          </p>
        </div>

        <div className="mt-10 flex-1">
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
            <NotificationStep
              value={flow.notifications}
              onChange={flow.setNotifications}
              featureSetup={flow.featureSetupSelection}
              onFeatureSetupChange={flow.setFeatureSetupSelection}
              featureSetupCommand={flow.featureSetupTerminalCommand}
              featureSetupCommandSelection={flow.featureSetupTerminalSelection}
            />
          )}
          {currentStep.id === 'repo' && (
            <RepoStep
              cloneUrl={flow.cloneUrl}
              onCloneUrlChange={flow.setCloneUrl}
              onOpenFolder={() => void flow.openFolder()}
              onClone={() => void flow.clone()}
              workspaceDir={flow.settings?.workspaceDir ?? ''}
              busyLabel={flow.busyLabel}
              error={flow.error}
            />
          )}
        </div>

        <footer className="mt-10 flex items-center justify-between border-t border-border pt-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {enterLabel}
            </kbd>
            <span>
              {currentStep.id === 'repo'
                ? 'open folder'
                : currentStep.id === 'notifications' &&
                    flow.hasSelectedFeatureSetup &&
                    !flow.featureSetupTerminalCommand
                  ? 'set up'
                  : 'continue'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={cn(
                currentStep.id === 'repo'
                  ? 'rounded-md border border-foreground/20 bg-muted px-3 py-2 text-sm font-medium text-foreground hover:bg-muted-foreground/10'
                  : 'rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground',
                'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-muted-foreground'
              )}
              disabled={Boolean(busyLabel)}
              onClick={() => void flow.skip()}
            >
              {currentStep.id === 'repo' ? "I'll add one later" : 'Skip'}
            </button>
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
            {currentStep.id !== 'repo' && (
              <button
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                aria-busy={Boolean(busyLabel)}
                disabled={Boolean(busyLabel)}
                onClick={() => void flow.next()}
              >
                {busyLabel ? <Loader2 className="size-4 animate-spin" /> : null}
                {primaryActionLabel}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
