import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { RefreshCw, Terminal } from 'lucide-react'
import { IntegrationStatusPill } from '../integration-status-pill'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { Button } from '../ui/button'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import { cn } from '@/lib/utils'

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
  preInstallNotice?: ReactNode
  getPrerequisiteStatus?: () => Promise<SkillPrerequisiteStatus>
  isPrerequisiteAvailable?: (status: SkillPrerequisiteStatus) => boolean
  onBeforeOpenTerminal?: () => void | Promise<void>
  showInstallWhenInstalled?: boolean
  showRecheckWhenInstalled?: boolean
  onRecheck: () => void | Promise<void>
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
  preInstallNotice,
  getPrerequisiteStatus,
  isPrerequisiteAvailable = isOrcaCliAvailableOnPath,
  onBeforeOpenTerminal,
  showInstallWhenInstalled = true,
  showRecheckWhenInstalled = true,
  onRecheck
}: AgentSkillSetupPanelProps): React.JSX.Element {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [preInstallNoticeVisible, setPreInstallNoticeVisible] = useState(Boolean(preInstallNotice))
  const mountedRef = useMountedRef()
  const readPrerequisiteStatus = useCallback(
    () => (getPrerequisiteStatus ?? window.api.cli.getInstallStatus)(),
    [getPrerequisiteStatus]
  )

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
          Install
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
          Re-check
        </Button>
      ) : null}
    </div>
  )

  return (
    <div
      className={cn(
        variant === 'card' ? 'rounded-xl border border-border bg-muted/20' : null,
        className
      )}
    >
      <div
        className={variant === 'card' ? cn('px-5 pt-5', terminalOpen ? 'pb-2' : 'pb-5') : undefined}
      >
        <div className="flex items-center gap-4">
          {leading}
          {icon ? (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 flex-1 self-center">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold leading-tight text-foreground">{title}</h3>
              {loading && !installed ? (
                <IntegrationStatusPill tone="neutral">Checking...</IntegrationStatusPill>
              ) : installed ? (
                <IntegrationStatusPill tone="connected">Installed</IntegrationStatusPill>
              ) : (
                <IntegrationStatusPill tone="attention">Not installed</IntegrationStatusPill>
              )}
            </div>
            {error ? <p className="mt-1 text-[12px] text-destructive">{error}</p> : null}
          </div>
        </div>
        <div className="mt-3 max-w-none">
          <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
          {actionRow}
          {!installed && preInstallNotice && preInstallNoticeVisible ? (
            <p className="mt-3 text-[12px] leading-snug text-muted-foreground">
              {preInstallNotice}
            </p>
          ) : null}
        </div>
      </div>
      {terminalOpen ? (
        <div className={cn(variant === 'card' ? 'px-5 pb-5' : 'mt-2')}>
          <OnboardingInlineCommandTerminal
            worktreeId={terminalWorktreeId}
            command={command}
            title={terminalTitle}
            ariaLabel={terminalAriaLabel}
            terminalHeightPx={terminalHeightPx}
            shellOverride={terminalShellOverride}
            terminalTopMarginPx={0}
            autoScrollIntoView={false}
            onTerminalExit={notifyInstalledAgentSkillsChanged}
          />
        </div>
      ) : null}
    </div>
  )
}
