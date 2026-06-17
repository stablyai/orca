import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Copy, RefreshCw, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import { IntegrationStatusPill } from '../integration-status-pill'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type AgentSkillSetupPanelVariant = 'card' | 'inline'
type SkillPrerequisiteStatus = Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>

type AgentSkillSetupPanelProps = {
  title: string
  description: ReactNode
  command: string
  terminalTitle: string
  terminalAriaLabel: string
  terminalWorktreeId: string
  installed: boolean
  loading: boolean
  error: string | null
  installDisabled?: boolean
  terminalHeightPx?: number
  terminalShellOverride?: string
  leading?: ReactNode
  icon?: ReactNode
  variant?: AgentSkillSetupPanelVariant
  className?: string
  // Why: when an enclosing surface (e.g. a modal) already shows the title and
  // status, hide the panel's own header row to avoid a duplicate heading.
  hideHeader?: boolean
  preInstallNotice?: ReactNode
  getPrerequisiteStatus?: () => Promise<SkillPrerequisiteStatus>
  isPrerequisiteAvailable?: (status: SkillPrerequisiteStatus) => boolean
  onBeforeOpenTerminal?: () => void | Promise<void>
  showInstallWhenInstalled?: boolean
  showRecheckWhenInstalled?: boolean
  installLabel?: string
  installedInstallLabel?: string
  actionHint?: ReactNode
  footer?: ReactNode
  onRecheck: () => void | Promise<unknown>
}

export function AgentSkillSetupPanel({
  title,
  description,
  command,
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
  installLabel = 'Install',
  installedInstallLabel = 'Update',
  actionHint,
  footer,
  onRecheck
}: AgentSkillSetupPanelProps): React.JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [preInstallNoticeVisible, setPreInstallNoticeVisible] = useState(
    Boolean(preInstallNotice && !installed)
  )
  const mountedRef = useMountedRef()
  const readPrerequisiteStatus = useCallback(
    () => (getPrerequisiteStatus ?? window.api.cli.getInstallStatus)(),
    [getPrerequisiteStatus]
  )
  const actionLabel = installed && preInstallNoticeVisible ? installLabel : installedInstallLabel

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

  const copyInstallCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(command)
      toast.success(
        translate(
          'auto.components.settings.AgentSkillSetupPanel.378ad26865',
          'Copied install command.'
        )
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.AgentSkillSetupPanel.a31e2aa302',
              'Failed to copy install command.'
            )
      )
    }
  }

  const actionRow = (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {!installed || showInstallWhenInstalled ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void (async () => {
              try {
                await onBeforeOpenTerminal?.()
                await refreshPreInstallNotice()
              } finally {
                if (mountedRef.current) {
                  setTerminalOpen(true)
                }
              }
            })()
          }}
          disabled={terminalOpen || installDisabled}
        >
          <Terminal className="size-3.5" />
          {installed ? actionLabel : installLabel}
        </Button>
      ) : null}
      {!installed || showRecheckWhenInstalled ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => void onRecheck()}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          {translate('auto.components.settings.AgentSkillSetupPanel.c689392435', 'Re-check')}
        </Button>
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
          error ? (
            <p className="text-[12px] text-destructive">{error}</p>
          ) : null
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
                {loading && !installed ? (
                  <IntegrationStatusPill tone="neutral">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.68a468752e',
                      'Checking...'
                    )}
                  </IntegrationStatusPill>
                ) : installed ? (
                  <IntegrationStatusPill tone="connected">
                    {translate(
                      'auto.components.settings.AgentSkillSetupPanel.9fcebceb2a',
                      'Installed'
                    )}
                  </IntegrationStatusPill>
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
          <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
          {actionRow}
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
              {command}
            </code>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={translate(
                    'auto.components.settings.AgentSkillSetupPanel.817d3f9f18',
                    'Copy install command'
                  )}
                  onClick={() => void copyInstallCommand()}
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
            worktreeId={terminalWorktreeId}
            command={command}
            title={terminalTitle}
            description={translate(
              'auto.components.settings.AgentSkillSetupPanel.0b810ec59f',
              'Press Enter to run the install command.'
            )}
            ariaLabel={terminalAriaLabel}
            terminalHeightPx={terminalHeightPx}
            shellOverride={terminalShellOverride}
            terminalTopMarginPx={8}
            descriptionPaddingClassName="px-4 py-2"
            autoScrollIntoView={false}
            onTerminalExit={notifyInstalledAgentSkillsChanged}
          />
        </div>
      ) : null}
    </div>
  )
}
