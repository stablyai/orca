// New bot on a WSL host with no Linux agent: how to install one there, re-checked while it shows.
import React, { useEffect } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { useAppStore } from '@/store'
import { agentSessionInstallCommand } from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

const REPROBE_MS = 10_000

/** Re-reads the host's agents every 10 s and on focus, so one installed in a terminal shows up. */
function useWslAgentReprobe(environmentId: string): void {
  useEffect(() => {
    const probe = (): void => {
      if (document.visibilityState === 'visible') {
        void useAppStore
          .getState()
          .refreshRuntimeDetectedAgents(environmentId)
          .catch(() => {})
      }
    }
    const timer = window.setInterval(probe, REPROBE_MS)
    window.addEventListener('focus', probe)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', probe)
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
  useWslAgentReprobe(environmentId)
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
        <p role="status" className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <LoadingSpinner className="size-3" />
          {t('bots.new.wslNoAgent.checking', 'Checking again…')}
        </p>
      </div>
    </div>
  )
}
