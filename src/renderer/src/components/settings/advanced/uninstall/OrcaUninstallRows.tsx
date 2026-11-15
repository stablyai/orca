import type React from 'react'
import { useState } from 'react'
import { ChevronRight, Folder, Monitor, Server, Terminal } from 'lucide-react'
import { Trans } from 'react-i18next'
import type {
  OrcaUninstallAgentEntry,
  OrcaUninstallHostEntry,
  OrcaUninstallSimpleEntry,
  OrcaUninstallStep
} from '../../../../../../shared/uninstall/orca-uninstall-types'
import type { TerminalAgent } from '../../../../../../shared/agent-status/identity/terminal-agent'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { cn } from '@/lib/class-names'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { getOrcaUninstallStepStates, isOrcaUninstallProblem } from './orca-uninstall-plan-state'
import {
  getOrcaUninstallSlotKind,
  OrcaUninstallCopyCommandButton,
  OrcaUninstallStatusIcon,
  type OrcaUninstallSlotKind
} from './OrcaUninstallStatus'
import { orcaUninstallRetryKey, type OrcaUninstallModel } from './use-orca-uninstall'

const VISIBLE_AGENT_LOGOS = 7
const ROW_CLASS =
  'grid min-h-10 w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5 text-left text-[13px]'
const SUB_ROW_CLASS =
  'grid min-h-[30px] grid-cols-[14px_104px_minmax(0,1fr)_auto] items-center gap-2.5 text-settings-detail'
const META_CLASS = 'justify-self-end text-right text-xs text-muted-foreground'
const PATH_CLASS = 'break-all py-1.5 font-mono text-2xs text-muted-foreground'

type RowsModel = Pick<OrcaUninstallModel, 'plan' | 'phase' | 'runningStep' | 'retrying' | 'retry'>

function isStepBusy(model: RowsModel, step: OrcaUninstallStep): boolean {
  if (model.runningStep === step) {
    return true
  }
  const prefix = orcaUninstallRetryKey(step)
  return [...model.retrying].some((key) => key === prefix || key.startsWith(`${prefix}:`))
}

/** Before the run a row shows what it will remove; from then on the slot shows progress. */
function RowSlot({
  model,
  step,
  meta,
  detail
}: {
  model: RowsModel
  step: OrcaUninstallStep
  meta: React.ReactNode
  detail?: string | null
}): React.JSX.Element {
  if (model.phase === 'idle' || !model.plan) {
    return <span className={META_CLASS}>{meta}</span>
  }
  const kind = getOrcaUninstallSlotKind(
    getOrcaUninstallStepStates(model.plan, step),
    isStepBusy(model, step)
  )
  return (
    <span className="flex justify-self-end">
      <OrcaUninstallStatusIcon kind={kind} detail={detail} />
    </span>
  )
}

function ExpandableRow({
  expanded,
  onToggle,
  label,
  slot
}: {
  expanded: boolean
  onToggle: () => void
  label: React.ReactNode
  slot: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={cn(
        ROW_CLASS,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'
      )}
    >
      <ChevronRight
        className={cn(
          'size-3.5 text-muted-foreground transition-transform',
          expanded && 'rotate-90'
        )}
      />
      <span className="flex min-w-0 flex-wrap items-center gap-2">{label}</span>
      {slot}
    </button>
  )
}

function SimpleRow({
  icon,
  label,
  slot
}: {
  icon: React.ReactNode
  label: React.ReactNode
  slot: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={ROW_CLASS}>
      <span className="flex text-muted-foreground">{icon}</span>
      <span className="min-w-0">{label}</span>
      {slot}
    </div>
  )
}

function SubRowSlot({
  kind,
  detail,
  action
}: {
  kind: OrcaUninstallSlotKind
  detail: string | null
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2 justify-self-end">
      {kind === 'problem' ? action : null}
      <OrcaUninstallStatusIcon kind={kind} detail={detail} />
    </span>
  )
}

function useAutoExpand(hasProblem: boolean): [boolean, () => void] {
  // Null follows the rows: a list with a problem opens itself until the user toggles it.
  const [choice, setChoice] = useState<boolean | null>(null)
  const expanded = choice ?? hasProblem
  return [expanded, () => setChoice(!expanded)]
}

function AgentRows({ model }: { model: RowsModel }): React.JSX.Element | null {
  const t = useTranslate()
  const agents = model.plan?.agents ?? []
  const [expanded, toggle] = useAutoExpand(
    agents.some((entry) => isOrcaUninstallProblem(entry.state))
  )
  if (agents.length === 0) {
    return null
  }
  const hidden = agents.length - VISIBLE_AGENT_LOGOS
  return (
    <>
      <ExpandableRow
        expanded={expanded}
        onToggle={toggle}
        label={
          <>
            <span>
              {t('settings.uninstall.rows.agents', 'Hooks in {{count}} agents', {
                count: agents.length,
                defaultValue_one: 'Hooks in 1 agent'
              })}
            </span>
            <span className="flex items-center gap-1">
              {agents.slice(0, VISIBLE_AGENT_LOGOS).map((entry) => (
                <AgentIcon key={entry.agent} agent={entry.agent as TerminalAgent} size={14} />
              ))}
              {hidden > 0 ? <span className="text-xs text-muted-foreground">+{hidden}</span> : null}
            </span>
          </>
        }
        slot={<RowSlot model={model} step="agent-hooks" meta={null} />}
      />
      {expanded ? (
        <div className="pl-6">
          {agents.map((entry) => (
            <AgentSubRow key={entry.agent} model={model} entry={entry} />
          ))}
        </div>
      ) : null}
    </>
  )
}

function AgentSubRow({
  model,
  entry
}: {
  model: RowsModel
  entry: OrcaUninstallAgentEntry
}): React.JSX.Element {
  const t = useTranslate()
  const agent = entry.agent as TerminalAgent
  const running =
    (model.runningStep === 'agent-hooks' && entry.state === 'present') ||
    model.retrying.has(orcaUninstallRetryKey('agent-hooks', entry.agent))
  const kind = getOrcaUninstallSlotKind([entry.state], running)
  return (
    <div className={SUB_ROW_CLASS}>
      <AgentIcon agent={agent} size={14} />
      <span className="min-w-0 break-words">{getAgentLabel(agent)}</span>
      <span className={PATH_CLASS}>
        {entry.paths.map((path) => (
          <span key={path} className="block">
            {path}
          </span>
        ))}
      </span>
      <SubRowSlot
        kind={model.phase === 'idle' ? 'blank' : kind}
        detail={entry.detail}
        action={
          model.phase === 'done' && entry.state === 'error' ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => model.retry({ step: 'agent-hooks', only: [entry.agent] })}
            >
              {t('settings.uninstall.retry', 'Retry')}
            </Button>
          ) : null
        }
      />
    </div>
  )
}

function HostRows({ model }: { model: RowsModel }): React.JSX.Element | null {
  const t = useTranslate()
  const hosts = model.plan?.hosts ?? []
  const [expanded, toggle] = useAutoExpand(
    hosts.some((entry) => isOrcaUninstallProblem(entry.state))
  )
  if (hosts.length === 0) {
    return null
  }
  return (
    <>
      <ExpandableRow
        expanded={expanded}
        onToggle={toggle}
        label={t('settings.uninstall.rows.hosts', 'SSH hosts')}
        slot={
          <RowSlot
            model={model}
            step="ssh-hosts"
            meta={t('settings.uninstall.rows.hostCount', '{{count}} hosts', {
              count: hosts.length,
              defaultValue_one: '1 host'
            })}
          />
        }
      />
      {expanded ? (
        <div className="pl-6">
          {hosts.map((entry) => (
            <HostSubRow key={entry.hostId} model={model} entry={entry} />
          ))}
        </div>
      ) : null}
    </>
  )
}

function HostSubRow({
  model,
  entry
}: {
  model: RowsModel
  entry: OrcaUninstallHostEntry
}): React.JSX.Element {
  const t = useTranslate()
  const running =
    (model.runningStep === 'ssh-hosts' && entry.state === 'present') ||
    model.retrying.has(orcaUninstallRetryKey('ssh-hosts', entry.hostId))
  const kind = getOrcaUninstallSlotKind([entry.state], running)
  let action: React.ReactNode = null
  if (model.phase === 'done' && entry.state === 'needs-user' && entry.manualCommand) {
    action = <OrcaUninstallCopyCommandButton command={entry.manualCommand} />
  } else if (model.phase === 'done' && entry.state === 'error') {
    action = (
      <Button
        variant="outline"
        size="xs"
        onClick={() => model.retry({ step: 'ssh-hosts', only: [entry.hostId] })}
      >
        {t('settings.uninstall.retry', 'Retry')}
      </Button>
    )
  }
  return (
    <div className={SUB_ROW_CLASS}>
      <Monitor className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 break-words">{entry.label}</span>
      <span className={PATH_CLASS}>
        {entry.connected
          ? t('settings.uninstall.host.connected', 'Connected')
          : t('settings.uninstall.host.offline', 'Offline')}
      </span>
      <SubRowSlot
        kind={model.phase === 'idle' ? 'blank' : kind}
        detail={entry.detail}
        action={action}
      />
    </div>
  )
}

function SimpleStepRow({
  model,
  step,
  entry,
  icon,
  label,
  mono
}: {
  model: RowsModel
  step: OrcaUninstallStep
  entry: OrcaUninstallSimpleEntry | null
  icon: React.ReactNode
  label: React.ReactNode
  mono: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!entry) {
    return null
  }
  const showRetry = model.phase === 'done' && entry.state === 'error' && !isStepBusy(model, step)
  return (
    <SimpleRow
      icon={icon}
      label={label}
      slot={
        <span className="flex items-center gap-2 justify-self-end">
          {showRetry ? (
            <Button variant="outline" size="xs" onClick={() => model.retry({ step })}>
              {t('settings.uninstall.retry', 'Retry')}
            </Button>
          ) : null}
          <RowSlot
            model={model}
            step={step}
            detail={entry.detail}
            meta={<span className={cn('break-all', mono && 'font-mono')}>{entry.location}</span>}
          />
        </span>
      }
    />
  )
}

/** One row per part of the plan, in run order, with the same rules and inset as the card. */
export function OrcaUninstallRows({ model }: { model: RowsModel }): React.JSX.Element | null {
  const t = useTranslate()
  const plan = model.plan
  if (!plan) {
    return null
  }
  return (
    <>
      <AgentRows model={model} />
      <SimpleStepRow
        model={model}
        step="cli-command"
        entry={plan.cliCommand}
        icon={<Terminal className="size-3.5" />}
        label={
          plan.cliCommand ? (
            <Trans
              i18n={i18n}
              defaults={t('settings.uninstall.rows.cliCommand', '<cmd>{{name}}</cmd> command')}
              values={{ name: plan.cliCommand.commandName }}
              components={{ cmd: <code className="font-mono text-xs" /> }}
            />
          ) : null
        }
        mono
      />
      <SimpleStepRow
        model={model}
        step="background-service"
        entry={plan.backgroundService}
        icon={<Server className="size-3.5" />}
        label={t('settings.uninstall.rows.service', 'Background service')}
        mono={false}
      />
      <SimpleStepRow
        model={model}
        step="hook-scripts"
        entry={plan.hookScripts}
        icon={<Folder className="size-3.5" />}
        label={t('settings.uninstall.rows.hookScripts', 'Hook scripts')}
        mono
      />
      <HostRows model={model} />
    </>
  )
}
