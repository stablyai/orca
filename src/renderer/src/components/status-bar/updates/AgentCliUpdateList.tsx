import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/index'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { agentCliProductName } from '@/components/agent-cli-update/agent-cli-product-name'
import { AgentCliUpdateFailedChip } from '@/components/agent-cli-update/AgentCliUpdateFailedChip'
import { openAgentCliUpdateFailure } from '@/components/agent-cli-update/agent-cli-update-failure-modal'
import {
  agentCliUpdateHostTarget,
  type AgentCliUpdateHost,
  type AgentCliUpdateRun
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
  /** Null when every row is on this computer and no other host is added, so no host heading is needed. */
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

export function runAgentCliUpdateRow(row: AgentCliUpdateRow): void {
  void useAppStore.getState().runAgentCliUpdate(agentCliUpdateHostTarget(row.hostKey), row.agent)
}

/** For a CLI Orca can't update itself: the user runs its command in a terminal. Resolves whether it copied. */
export function copyAgentCliUpdateCommand(
  command: string,
  t: Translate,
  // Off when the button itself shows that it copied.
  { announce = true }: { announce?: boolean } = {}
): Promise<boolean> {
  return window.api.ui.writeClipboardText(command).then(
    () => {
      if (announce) {
        toast.success(t('agentCliUpdate.commandCopied', 'Command copied'))
      }
      return true
    },
    () => {
      toast.error(t('agentCliUpdate.commandNotCopied', 'Could not copy the command'))
      return false
    }
  )
}

function AgentCliUpdateListRow({
  row,
  onUpdate
}: {
  row: AgentCliUpdateRow
  onUpdate: (row: AgentCliUpdateRow) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { update, run } = row
  const manual = update && !update.runnable ? update.command : null
  return (
    <div>
      <div className="flex h-9 items-center gap-2 rounded-md pr-1 pl-2">
        <AgentIcon agent={row.agent} size={14} />
        <span className="truncate text-[13px]">{agentCliProductName(row.agent, t, 'short')}</span>
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
              <AgentCliUpdateFailedChip
                onOpen={() =>
                  openAgentCliUpdateFailure({
                    hostKey: row.hostKey,
                    agent: row.agent,
                    tryAgain: () => onUpdate(row)
                  })
                }
              />
              <Button type="button" variant="outline" size="xs" onClick={() => onUpdate(row)}>
                {t('agentCliUpdate.tryAgain', 'Try again')}
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
                  onClick={() => void copyAgentCliUpdateCommand(manual, t)}
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
  const rows = groups.flatMap((group) => group.rows)
  const startable = rows.filter(agentCliUpdateStartable)
  return (
    <div className="flex flex-col p-1">
      {/* Same right inset as the rows, so Update all lines up with their buttons. */}
      <div className="flex min-h-7 items-center gap-2 pr-1 pl-2">
        <span className="text-2xs font-medium text-muted-foreground">
          {t('agentCliUpdate.heading', '{{count}} CLI updates available', {
            count: rows.length,
            defaultValue_one: '{{count}} CLI update available'
          })}
        </span>
        {startable.length > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onUpdateAll}
          >
            {t('agentCliUpdate.updateAll', 'Update all')}
          </Button>
        ) : null}
      </div>
      {groups.map((group) => (
        <div key={group.hostKey}>
          {group.label ? (
            <div className="px-2 pt-1.5 pb-1 text-2xs text-muted-foreground">{group.label}</div>
          ) : null}
          {group.rows.map((row) => (
            <AgentCliUpdateListRow key={row.agent} row={row} onUpdate={onUpdate} />
          ))}
        </div>
      ))}
    </div>
  )
}
