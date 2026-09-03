import type { ComponentProps } from 'react'
import { Loader2, RefreshCw, Terminal } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { syncSurfacesAfterAgentSkillRecheck } from './agent-skill-recheck-surface-sync'

type Props = {
  installed: boolean
  loading: boolean
  installDisabled: boolean
  terminalOpen: boolean
  terminalOpening: boolean
  setupAttemptRunning: boolean
  setupCommandFailedCode: number | null
  showInstallWhenInstalled: boolean
  showRecheckWhenInstalled: boolean
  removeCommand?: string
  installVariant: ComponentProps<typeof Button>['variant']
  resolvedInstallLabel: string
  resolvedInstalledInstallLabel: string
  openingHint?: React.ReactNode
  freshnessSkillName?: string
  onOpenSetupTerminal: (commandOverride?: string) => void
  onRecheck: () => void | Promise<unknown>
}

export function AgentSkillSetupPanelActions({
  installed,
  loading,
  installDisabled,
  terminalOpen,
  terminalOpening,
  setupAttemptRunning,
  setupCommandFailedCode,
  showInstallWhenInstalled,
  showRecheckWhenInstalled,
  removeCommand,
  installVariant,
  resolvedInstallLabel,
  resolvedInstalledInstallLabel,
  openingHint,
  freshnessSkillName,
  onOpenSetupTerminal,
  onRecheck
}: Props): React.JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {(!installed || showInstallWhenInstalled) && setupCommandFailedCode === null ? (
        <Button
          type="button"
          variant={installVariant}
          size="sm"
          onClick={() => onOpenSetupTerminal()}
          disabled={terminalOpen || installDisabled || terminalOpening}
        >
          {terminalOpening ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Terminal className="size-3.5" />
          )}
          {terminalOpening
            ? translate('auto.components.settings.AgentSkillSetupPanel.5f818f12ab', 'Preparing...')
            : installed
              ? resolvedInstalledInstallLabel
              : resolvedInstallLabel}
        </Button>
      ) : null}
      {installed && removeCommand && setupCommandFailedCode === null ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onOpenSetupTerminal(removeCommand)}
          disabled={terminalOpen || installDisabled || terminalOpening || setupAttemptRunning}
        >
          {translate('auto.components.settings.AgentSkillSetupPanel.removeLabel', 'Remove')}
        </Button>
      ) : null}
      {setupCommandFailedCode !== null || !installed || showRecheckWhenInstalled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            if (setupCommandFailedCode !== null) {
              onOpenSetupTerminal()
              return
            }
            void Promise.resolve(onRecheck()).then(() => {
              syncSurfacesAfterAgentSkillRecheck(freshnessSkillName)
            })
          }}
          disabled={
            setupCommandFailedCode !== null
              ? installDisabled || terminalOpening || setupAttemptRunning
              : loading
          }
        >
          <RefreshCw className={cn('size-3.5', (loading || terminalOpening) && 'animate-spin')} />
          {setupCommandFailedCode !== null
            ? translate('auto.components.settings.AgentSkillSetupPanel.retrySetup', 'Retry')
            : translate('auto.components.settings.AgentSkillSetupPanel.c689392435', 'Re-check')}
        </Button>
      ) : null}
      {terminalOpening ? (
        <p className="basis-full text-[12px] leading-snug text-muted-foreground">
          {openingHint ??
            translate(
              'auto.components.settings.AgentSkillSetupPanel.4c05b9d7cb',
              'Preparing setup terminal.'
            )}
        </p>
      ) : null}
    </div>
  )
}
