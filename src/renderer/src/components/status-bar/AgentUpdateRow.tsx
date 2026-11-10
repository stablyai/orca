import { CheckCircle2, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentUpdateRow as AgentUpdateRowState } from '../../../../shared/agent-updates/agent-update-types'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'

export function AgentUpdateRow({
  row,
  updatesLocked,
  onUpdate
}: {
  row: AgentUpdateRowState
  /** True while any agent update is running; every update button waits for it. */
  updatesLocked: boolean
  onUpdate: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const failure = row.run?.state === 'failed' ? row.run.message : null
  // Why: after an update the installed build can be ahead of the release source, so show only it.
  const versions =
    row.run?.state === 'done' || row.current === row.latest
      ? row.current
      : `${row.current} → ${row.latest}`

  const copyCommand = async (command: string): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(command)
      toast.success(
        t('auto.components.status.bar.AgentUpdateStatusSegment.commandCopied', 'Command copied')
      )
    } catch {
      toast.error(
        t(
          'auto.components.status.bar.AgentUpdateStatusSegment.commandCopyFailed',
          'Could not copy the command'
        )
      )
    }
  }

  const trailing = (() => {
    if (row.run?.state === 'running') {
      return (
        <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('auto.components.status.bar.AgentUpdateStatusSegment.updating', 'Updating…')}
        </span>
      )
    }
    if (row.run?.state === 'done') {
      return (
        <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
          <CheckCircle2 className="size-3 text-status-success" />
          {t('auto.components.status.bar.AgentUpdateStatusSegment.upToDate', 'Up to date')}
        </span>
      )
    }
    if (row.action.kind === 'manual') {
      const { command } = row.action
      return (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t(
            'auto.components.status.bar.AgentUpdateStatusSegment.copyCommand',
            'Copy command'
          )}
          onClick={() => void copyCommand(command)}
        >
          <Copy />
        </Button>
      )
    }
    return (
      <Button variant="outline" size="xs" disabled={updatesLocked} onClick={onUpdate}>
        {failure === null
          ? t('auto.components.status.bar.AgentUpdateStatusSegment.update', 'Update')
          : t('auto.components.status.bar.AgentUpdateStatusSegment.retry', 'Retry')}
      </Button>
    )
  })()

  return (
    <li className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        <AgentIcon agent={row.agent} size={14} />
        <span className="truncate text-xs font-medium text-foreground">
          {tuiAgentDisplayName(row.agent) ?? row.agent}
        </span>
        <span className="min-w-0 truncate font-mono text-2xs tabular-nums text-muted-foreground">
          {versions}
        </span>
        <span className="ml-auto shrink-0">{trailing}</span>
      </div>
      {row.action.kind === 'manual' && row.run === null && (
        <code className="mt-1 block select-text break-all font-mono text-2xs text-muted-foreground">
          {row.action.command}
        </code>
      )}
      {failure !== null && (
        <p className="mt-1 truncate text-2xs text-destructive" title={failure}>
          {failure}
        </p>
      )}
    </li>
  )
}
