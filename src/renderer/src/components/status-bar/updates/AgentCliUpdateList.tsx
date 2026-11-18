import { useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliProductName } from '@/components/agent-cli-update/agent-cli-product-name'
import type {
  AgentCliUpdateHost,
  AgentCliUpdateRun
} from '@/store/slices/runtime-host-updates/agent-cli-updates'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdate,
  type AgentCliUpdateAgent
} from '../../../../../shared/agent-launch/installation/agent-cli-update'

export type AgentCliUpdateRow = {
  hostKey: string
  agent: AgentCliUpdateAgent
  update: AgentCliUpdate | null
  run: AgentCliUpdateRun | null
}

export type AgentCliUpdateGroup = {
  hostKey: string
  /** Null when every row is on this computer, so no host heading is needed. */
  label: string | null
  rows: readonly AgentCliUpdateRow[]
}

/** Every update offered or run on a host, including one started from a chat's notice. */
export function agentCliUpdateRows(hostKey: string, host: AgentCliUpdateHost): AgentCliUpdateRow[] {
  const agents = AGENT_CLI_UPDATE_AGENTS.filter(
    (agent) => host.runs[agent] || host.updates.some((update) => update.agent === agent)
  )
  return agents.map((agent) => ({
    hostKey,
    agent,
    update: host.updates.find((update) => update.agent === agent) ?? null,
    run: host.runs[agent] ?? null
  }))
}

/** Rows Update all may start: offered, runnable and not already running. */
export function agentCliUpdateStartable(row: AgentCliUpdateRow): boolean {
  return row.update?.runnable === true && row.run?.phase !== 'running'
}

function AgentCliUpdateListRow({
  row,
  onUpdate
}: {
  row: AgentCliUpdateRow
  onUpdate: (row: AgentCliUpdateRow) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [outputShown, setOutputShown] = useState(false)
  const { update, run } = row
  const manual = update && !update.runnable ? update.command : null
  const copyCommand = (command: string) =>
    void navigator.clipboard.writeText(command).then(
      () => toast.success(t('agentCliUpdate.commandCopied', 'Command copied')),
      () => toast.error(t('agentCliUpdate.commandNotCopied', 'Could not copy the command'))
    )
  return (
    <div>
      <div className="flex h-9 items-center gap-2 rounded-md pr-1 pl-2">
        <AgentIcon agent={row.agent} size={14} />
        <span className="truncate text-[13px]">{agentCliProductName(row.agent, t)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {run?.phase === 'running' ? (
            <>
              <span className="text-2xs text-muted-foreground">
                {t('agentCliUpdate.updating', 'Updating…')}
              </span>
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            </>
          ) : run?.phase === 'failed' ? (
            <>
              <span className="text-2xs text-destructive">
                {t('agentCliUpdate.failed', 'Update failed')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-expanded={outputShown}
                onClick={() => setOutputShown(!outputShown)}
              >
                {outputShown
                  ? t('agentCliUpdate.hideOutput', 'Hide output')
                  : t('agentCliUpdate.showOutput', 'Show output')}
              </Button>
            </>
          ) : (
            <>
              {update ? (
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {t('agentCliUpdate.versions', '{{installed}} → {{latest}}', {
                    installed: update.installedVersion,
                    latest: update.latestVersion
                  })}
                </span>
              ) : null}
              {manual ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => copyCommand(manual)}
                >
                  <Copy />
                  {t('agentCliUpdate.copyCommand', 'Copy')}
                </Button>
              ) : (
                <Button type="button" variant="outline" size="xs" onClick={() => onUpdate(row)}>
                  {t('agentCliUpdate.update', 'Update')}
                </Button>
              )}
            </>
          )}
        </span>
      </div>
      {manual ? (
        <p className="px-2 pb-1.5 text-2xs text-muted-foreground">
          {t('agentCliUpdate.manualHint', 'Run in a terminal:')}{' '}
          <code className="font-mono break-all text-foreground">{manual}</code>
        </p>
      ) : null}
      {run?.phase === 'failed' && outputShown ? (
        <div className="space-y-1.5 px-2 pb-2">
          <pre className="scrollbar-sleek max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-2xs whitespace-pre-wrap break-all text-muted-foreground">
            {run.output || t('agentCliUpdate.noOutput', 'The command printed nothing.')}
          </pre>
          <Button type="button" variant="outline" size="xs" onClick={() => onUpdate(row)}>
            {t('agentCliUpdate.tryAgain', 'Try again')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** The status bar popover's body: one row per CLI, grouped by host when more than one is listed. */
export function AgentCliUpdateList({
  groups,
  onUpdate,
  onUpdateAll
}: {
  groups: readonly AgentCliUpdateGroup[]
  onUpdate: (row: AgentCliUpdateRow) => void
  onUpdateAll: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const startable = groups.flatMap((group) => group.rows).filter(agentCliUpdateStartable)
  return (
    <div className="flex flex-col p-1">
      {groups.map((group, index) => (
        <div key={group.hostKey}>
          <div className="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">
            {group.label ?? (index === 0 ? t('agentCliUpdate.heading', 'Updates') : null)}
          </div>
          {group.rows.map((row) => (
            <AgentCliUpdateListRow key={row.agent} row={row} onUpdate={onUpdate} />
          ))}
        </div>
      ))}
      {startable.length > 1 ? (
        <>
          <Separator className="my-1" />
          <div className="p-1">
            <Button type="button" size="sm" className="w-full" onClick={onUpdateAll}>
              {t('agentCliUpdate.updateAll', 'Update all')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
