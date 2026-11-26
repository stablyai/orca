// New bot on a WSL host with no Linux agent: how to install one there, re-checked on return or request.
import React, { useEffect } from 'react'
import { AlertCircle, Check, Copy, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { useAppStore } from '@/store'
import { getRuntimeAgentInventoryKey } from '@/store/slices/agent-inventory/runtime-agent-inventory-key'
import { agentSessionInstallCommand } from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

function reprobeWslAgents(environmentId: string, userInitiated = false): void {
  void useAppStore
    .getState()
    .refreshRuntimeDetectedAgents(
      environmentId,
      null,
      userInitiated ? { userInitiated: true } : undefined
    )
    .catch(() => {})
}

/** Re-reads the host's agents when returning to Orca, so one installed in a terminal shows up. */
function useWslAgentReprobeOnReturn(environmentId: string): void {
  useEffect(() => {
    const onFocus = (): void => {
      reprobeWslAgents(environmentId)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        reprobeWslAgents(environmentId)
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [environmentId])
}

export function BotWslNoAgentHint({
  distro,
  environmentId
}: {
  distro: string
  environmentId: string
}): React.JSX.Element {
  const t = useTranslate()
  useWslAgentReprobeOnReturn(environmentId)
  const inventoryKey = getRuntimeAgentInventoryKey(environmentId)
  const isRefreshing = useAppStore((s) => s.isRefreshingRuntimeAgents[inventoryKey] ?? false)
  const command = agentSessionInstallCommand('claude', 'linux') ?? ''
  const { copyText, status } = useClipboardTextCopyFeedback(command)
  return (
    <div
      data-bot-wsl-no-agent=""
      className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">
          {t('bots.new.wslNoAgent.title', 'Install an agent inside {{distro}}', { distro })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.new.wslNoAgent.body',
            'Agents installed on Windows can’t run inside WSL. Install one in the distro and sign in, and it shows up here.'
          )}
        </p>
        {command ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background/60 px-2 py-1 font-mono text-2xs">
              {command}
            </code>
            <Button type="button" variant="outline" size="xs" onClick={() => void copyText()}>
              {status === 'copied' ? <Check /> : <Copy />}
              {status === 'copied'
                ? t('bots.new.wslNoAgent.copied', 'Copied')
                : t('bots.new.wslNoAgent.copy', 'Copy')}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={isRefreshing}
            onClick={() => reprobeWslAgents(environmentId, true)}
          >
            {isRefreshing ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
            {isRefreshing
              ? t('bots.new.wslNoAgent.checking', 'Checking again…')
              : t('bots.new.wslNoAgent.checkAgain', 'Check again')}
          </Button>
        </div>
      </div>
    </div>
  )
}
