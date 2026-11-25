// New bot's compact card while a picked WSL distro is set up as a host, and when that fails.
import React, { useState } from 'react'
import { AlertCircle, Check, ChevronRight, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botWslSetupStepStates, type BotWslSetupStage } from './bot-wsl-setup-steps'
import type { BotWslSetupState } from './use-bot-wsl-setup'

function stepLabel(step: BotWslSetupStage, distro: string, t: Translate): string {
  switch (step) {
    case 'starting-distro':
      return t('bots.new.wslSetup.starting', 'Starting {{distro}}', { distro })
    case 'installing-server':
      return t('bots.new.wslSetup.installing', 'Installing Orca’s server in ~/.orca-remote')
    case 'connecting':
      return t('bots.new.wslSetup.connecting', 'Connecting')
    case 'finding-agents':
      return t('bots.new.wslSetup.findingAgents', 'Looking for agents in {{distro}}', { distro })
  }
}

const STEP_ICON = {
  done: <Check className="size-3.5 text-muted-foreground" aria-hidden />,
  active: <LoadingSpinner className="size-3.5" />,
  pending: <Circle className="size-2 text-muted-foreground/60" aria-hidden />
}

function SetupSteps({
  state
}: {
  state: Extract<BotWslSetupState, { phase: 'running' | 'finding-agents' }>
}) {
  const t = useTranslate()
  const name = state.distro.name
  const stage = state.phase === 'finding-agents' ? 'finding-agents' : state.stage
  return (
    <ol className="mt-2 space-y-1 text-xs" aria-live="polite">
      {botWslSetupStepStates(stage).map(({ step, state: stepState }) => (
        <li
          key={step}
          className={cn(
            'flex items-start gap-2',
            stepState === 'active' ? 'text-foreground' : 'text-muted-foreground',
            stepState === 'pending' && 'opacity-70'
          )}
        >
          <span className="flex h-4 w-3.5 shrink-0 items-center justify-center">
            {STEP_ICON[stepState]}
          </span>
          <span className="min-w-0">
            {stepLabel(step, name, t)}
            {step === 'installing-server' && stepState === 'active' ? (
              <span className="block text-2xs text-muted-foreground">
                {state.phase === 'running' && state.wait
                  ? state.wait
                  : t(
                      'bots.new.wslSetup.installingHint',
                      'The first time also downloads its Linux Node runtime.'
                    )}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

function FailedBody({
  state,
  onRetry,
  onChooseAnother
}: {
  state: Extract<BotWslSetupState, { phase: 'failed' }>
  onRetry: () => void
  onChooseAnother: () => void
}) {
  const t = useTranslate()
  return (
    <div className="flex items-start gap-2.5">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">
          {t('bots.new.wslSetup.failedTitle', 'Couldn’t set up {{distro}}', {
            distro: state.distro.name
          })}
        </p>
        <p role="alert" className="text-xs wrap-anywhere text-muted-foreground">
          {state.message}
        </p>
        {state.detail ? (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
              {t('bots.new.wslSetup.details', 'Details')}
            </CollapsibleTrigger>
            <CollapsibleContent animation="height">
              <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-2xs whitespace-pre-wrap text-muted-foreground scrollbar-sleek">
                {state.detail}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-0.5">
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            {t('bots.new.wslSetup.retry', 'Retry')}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={onChooseAnother}>
            {t('bots.new.wslSetup.chooseAnother', 'Choose another computer')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Folds open while a setup runs or failed, and folds away once the host's agents are known. */
export function BotWslSetupCard({
  state,
  onCancel,
  onRetry,
  onChooseAnother
}: {
  state: BotWslSetupState
  onCancel: () => void
  onRetry: () => void
  onChooseAnother: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // The last setup stays drawn while the card folds, so it shrinks instead of blanking first.
  const [shown, setShown] = useState<Exclude<BotWslSetupState, { phase: 'idle' }> | null>(null)
  if (state.phase !== 'idle' && state !== shown) {
    setShown(state)
  }
  return (
    <Collapsible open={state.phase !== 'idle'}>
      <CollapsibleContent animation="height">
        {shown ? (
          <div
            data-bot-wsl-setup={shown.phase}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
          >
            {shown.phase === 'failed' ? (
              <FailedBody state={shown} onRetry={onRetry} onChooseAnother={onChooseAnother} />
            ) : (
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {t('bots.new.wslSetup.title', 'Setting up {{distro}} as a host', {
                      distro: shown.distro.name
                    })}
                  </p>
                  <p className="text-2xs text-muted-foreground">
                    {t(
                      'bots.new.wslSetup.subtitle',
                      'About a minute the first time. Your Windows files and other distros aren’t touched.'
                    )}
                  </p>
                  <SetupSteps state={shown} />
                </div>
                {shown.phase === 'running' ? (
                  <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
                    {t('bots.new.wslSetup.cancel', 'Cancel')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
