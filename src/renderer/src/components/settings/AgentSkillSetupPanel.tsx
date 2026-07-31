import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Loader2, RefreshCw, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { IntegrationStatusPill } from '../integration-status-pill'
import { SkillFreshnessStatusPill } from '../skills/SkillFreshnessStatusPill'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { AgentSkillSetupFailureNotice } from './AgentSkillSetupFailureNotice'
import type { AgentSkillSetupPanelProps } from './agent-skill-setup-panel-props'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  notifyInstalledAgentSkillsChanged,
  notifyInstalledAgentSkillsRefreshed
} from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function AgentSkillSetupPanel({
  title,
  description,
  command,
  installedCommand,
  terminalTitle,
  terminalAriaLabel,
  terminalWorktreeId,
  installed,
  loading,
  error,
  installDisabled = false,
  terminalHeightPx,
  terminalShellOverride,
  leading,
  icon,
  variant = 'card',
  className,
  hideHeader = false,
  preInstallNotice,
  getPrerequisiteStatus,
  isPrerequisiteAvailable = isOrcaCliAvailableOnPath,
  onBeforeOpenTerminal,
  showInstallWhenInstalled = true,
  showRecheckWhenInstalled = true,
  installLabel,
  installedInstallLabel,
  installVariant = 'outline',
  actionHint,
  openingHint,
  footer,
  onRecheck,
  freshnessSkillName
}: AgentSkillSetupPanelProps): React.JSX.Element {
  const resolvedInstallLabel =
    installLabel ??
    translate('auto.components.settings.AgentSkillSetupPanel.installLabel', 'Install')
  const resolvedInstalledInstallLabel =
    installedInstallLabel ??
    translate('auto.components.settings.AgentSkillSetupPanel.updateLabel', 'Update')
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null)
  const [terminalAttempt, setTerminalAttempt] = useState(0)
  const [terminalOpening, setTerminalOpening] = useState(false)
  const [setupAttemptRunning, setSetupAttemptRunning] = useState(false)
  const [setupCommandFailedCode, setSetupCommandFailedCode] = useState<number | null>(null)
  const setupAttemptRunningRef = useRef(false)
  const [preInstallNoticeVisible, setPreInstallNoticeVisible] = useState(
    Boolean(preInstallNotice && !installed)
  )
  const mountedRef = useMountedRef()
  const readPrerequisiteStatus = useCallback(
    () => (getPrerequisiteStatus ?? window.api.cli.getInstallStatus)(),
    [getPrerequisiteStatus]
  )
  const activeCommand = installed ? (installedCommand ?? command) : command
  // Why: the inline terminal auto-inserts when its command changes, so keep an
  // already-open terminal pinned to the command selected by the user's click.
  const openTerminalCommand = terminalCommand ?? activeCommand

  const openSetupTerminal = (): void => {
    if (terminalOpening || setupAttemptRunning) {
      return
    }
    const nextCommand =
      setupCommandFailedCode !== null && terminalCommand ? terminalCommand : activeCommand
    setTerminalOpening(true)
    if (setupCommandFailedCode !== null) {
      setTerminalOpen(false)
    }
    void (async () => {
      let shouldOpenTerminal = false
      try {
        await onBeforeOpenTerminal?.()
        await refreshPreInstallNotice()
        shouldOpenTerminal = true
      } catch {
        shouldOpenTerminal = false
      } finally {
        if (mountedRef.current) {
          setTerminalOpening(false)
          if (shouldOpenTerminal) {
            setTerminalCommand(nextCommand)
            setTerminalAttempt((attempt) => attempt + 1)
            setTerminalOpen(true)
            setupAttemptRunningRef.current = true
            setSetupAttemptRunning(true)
          }
        }
      }
    })()
  }

  // Why: PTY exit is the shell's status; OSC 133;D reports the install command.
  const handleSetupCommandFinished = useCallback(
    (bestEffortExitCode: number | null): void => {
      // Nested shells can emit duplicate completion markers in one PTY chunk.
      if (!setupAttemptRunningRef.current) {
        return
      }
      setupAttemptRunningRef.current = false
      setSetupAttemptRunning(false)
      if (bestEffortExitCode !== null) {
        setSetupCommandFailedCode(bestEffortExitCode === 0 ? null : bestEffortExitCode)
      }
      if (freshnessSkillName) {
        notifyInstalledAgentSkillsChanged()
      }
      void onRecheck()
    },
    [freshnessSkillName, onRecheck]
  )

  const handleTerminalExit = useCallback((): void => {
    if (mountedRef.current) {
      setupAttemptRunningRef.current = false
      setTerminalOpen(false)
      setSetupAttemptRunning(false)
    }
    notifyInstalledAgentSkillsChanged()
  }, [mountedRef])

  useEffect(() => {
    if (!preInstallNotice) {
      setPreInstallNoticeVisible(false)
      return
    }

    let canceled = false
    const refreshCliNotice = async (): Promise<void> => {
      try {
        const status = await readPrerequisiteStatus()
        if (!canceled) {
          setPreInstallNoticeVisible(!isPrerequisiteAvailable(status))
        }
      } catch {
        if (!canceled) {
          setPreInstallNoticeVisible(true)
        }
      }
    }

    void refreshCliNotice()
    window.addEventListener('focus', refreshCliNotice)
    return () => {
      canceled = true
      window.removeEventListener('focus', refreshCliNotice)
    }
  }, [isPrerequisiteAvailable, preInstallNotice, readPrerequisiteStatus])

  const refreshPreInstallNotice = async (): Promise<void> => {
    if (!preInstallNotice) {
      return
    }
    try {
      const status = await readPrerequisiteStatus()
      if (mountedRef.current) {
        setPreInstallNoticeVisible(!isPrerequisiteAvailable(status))
      }
    } catch {
      if (mountedRef.current) {
        setPreInstallNoticeVisible(true)
      }
    }
  }

  const copyActiveCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(openTerminalCommand)
      toast.success(
        translate('auto.components.settings.AgentSkillSetupPanel.copiedCommand', 'Copied command.')
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.AgentSkillSetupPanel.failedToCopyCommand',
              'Failed to copy command.'
            )
      )
    }
  }

  const actionRow = (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {(!installed || showInstallWhenInstalled) && setupCommandFailedCode === null ? (
        <Button
          type="button"
          variant={installVariant}
          size="sm"
          onClick={openSetupTerminal}
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
      {setupCommandFailedCode !== null || !installed || showRecheckWhenInstalled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => {
            if (setupCommandFailedCode !== null) {
              openSetupTerminal()
              return
            }
            void Promise.resolve(onRecheck()).then(() => {
              // Reuse the completed scan so sibling surfaces sync without rediscovery.
              notifyInstalledAgentSkillsRefreshed()
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

  return (
    <div
      className={cn(
        'min-w-0',
        variant === 'card' ? 'rounded-xl border border-border bg-muted/20' : null,
        className
      )}
    >
      <div
        className={variant === 'card' ? cn('px-5 pt-5', terminalOpen ? 'pb-2' : 'pb-5') : 'pt-1.5'}
      >
        {hideHeader ? (
          <>
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
            {/* hideHeader drops the title row; keep freshness so guided hubs still surface updates. */}
            {installed && freshnessSkillName && setupCommandFailedCode === null ? (
              <div className="mb-2">
                <SkillFreshnessStatusPill skillName={freshnessSkillName} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-4">
            {leading}
            {icon ? (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
                {icon}
              </div>
            ) : null}
            <div className="min-w-0 flex-1 self-center">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h3>
                {setupCommandFailedCode !== null ? (
                  <IntegrationStatusPill tone="attention">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.setupFailed',
                      'Setup failed'
                    )}
                  </IntegrationStatusPill>
                ) : loading && !installed ? (
                  <IntegrationStatusPill tone="neutral">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.68a468752e',
                      'Checking...'
                    )}
                  </IntegrationStatusPill>
                ) : installed ? (
                  freshnessSkillName ? (
                    <SkillFreshnessStatusPill skillName={freshnessSkillName} />
                  ) : (
                    <IntegrationStatusPill tone="connected">
                      {translate(
                        'auto.components.settings.AgentSkillSetupPanel.9fcebceb2a',
                        'Installed'
                      )}
                    </IntegrationStatusPill>
                  )
                ) : (
                  <IntegrationStatusPill tone="attention">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.5289300939',
                      'Not installed'
                    )}
                  </IntegrationStatusPill>
                )}
              </div>
              {error ? <p className="mt-1 text-[12px] text-destructive">{error}</p> : null}
            </div>
          </div>
        )}
        <div className={cn('max-w-none', hideHeader ? null : 'mt-3')}>
          {description != null ? (
            <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
          ) : null}
          {actionRow}
          <AgentSkillSetupFailureNotice exitCode={setupCommandFailedCode} />
          {actionHint ? <div className="mt-2">{actionHint}</div> : null}
          {!installed && preInstallNotice && preInstallNoticeVisible ? (
            <p className="mt-3 text-[12px] leading-snug text-muted-foreground">
              {preInstallNotice}
            </p>
          ) : null}
        </div>
        {footer ? (
          <div
            className={cn('border-t border-border/60', terminalOpen ? 'mt-2 pt-4' : 'mt-5 pt-5')}
          >
            {footer}
          </div>
        ) : null}
      </div>
      {terminalOpen ? (
        <div
          className={cn(
            'min-w-0 max-w-full overflow-hidden',
            variant === 'card' ? 'px-5 pb-5' : 'mt-2'
          )}
        >
          <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/35 px-3 py-2">
            <code className="scrollbar-sleek min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
              {openTerminalCommand}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={translate(
                    'auto.components.settings.AgentSkillSetupPanel.copyCommandAria',
                    'Copy command'
                  )}
                  onClick={() => void copyActiveCommand()}
                >
                  <Copy className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.settings.AgentSkillSetupPanel.ed197f59a2',
                  'Copy command'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          <OnboardingInlineCommandTerminal
            key={terminalAttempt}
            worktreeId={terminalWorktreeId}
            command={openTerminalCommand}
            title={terminalTitle}
            description={translate(
              'auto.components.settings.AgentSkillSetupPanel.runCommandDescription',
              'Press Enter to run the command.'
            )}
            ariaLabel={terminalAriaLabel}
            terminalHeightPx={terminalHeightPx}
            shellOverride={terminalShellOverride}
            terminalTopMarginPx={8}
            descriptionPaddingClassName="px-4 py-2"
            autoScrollIntoView={false}
            onTerminalExit={handleTerminalExit}
            onCommandFinished={handleSetupCommandFinished}
          />
        </div>
      ) : null}
    </div>
  )
}
