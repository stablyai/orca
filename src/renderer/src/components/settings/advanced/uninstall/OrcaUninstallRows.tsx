import type React from 'react'
import { Folder, Server, Terminal } from 'lucide-react'
import { Trans } from 'react-i18next'
import type {
  OrcaUninstallAgentEntry,
  OrcaUninstallSimpleEntry,
  OrcaUninstallStep
} from '../../../../../../shared/uninstall/orca-uninstall-types'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { cn } from '@/lib/class-names'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { isOrcaUninstallProblem } from './orca-uninstall-plan-state'
import { getOrcaUninstallSlotKind } from './OrcaUninstallStatus'
import {
  ExpandableRow,
  isStepBusy,
  PATH_CLASS,
  RowSlot,
  SimpleRow,
  SUB_ROW_CLASS,
  SubRowSlot,
  useAutoExpand,
  type RowsModel
} from './OrcaUninstallRowLayout'
import { OrcaUninstallHostRows } from './OrcaUninstallHostRows'
import { orcaUninstallRetryKey } from './use-orca-uninstall'

const VISIBLE_AGENT_LOGOS = 7
function AgentRows({ model }: { model: RowsModel }): React.JSX.Element | null {
  const t = useTranslate()
  const agents = model.plan?.agents ?? []
  const scripts = model.plan?.hookScripts ?? null
  const [expanded, toggle] = useAutoExpand(
    agents.some((entry) => isOrcaUninstallProblem(entry.state)) ||
      (scripts !== null && isOrcaUninstallProblem(scripts.state))
  )
  if (agents.length === 0 && !scripts) {
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
              {agents.length > 0
                ? t('settings.uninstall.rows.agents', 'Hooks in {{count}} agents', {
                    count: agents.length,
                    defaultValue_one: 'Hooks in 1 agent'
                  })
                : t('settings.uninstall.rows.hookScripts', 'Hook scripts')}
            </span>
            <span className="flex items-center gap-1">
              {agents.slice(0, VISIBLE_AGENT_LOGOS).map((entry) => (
                <AgentIcon
                  key={entry.agent}
                  agent={isTuiAgent(entry.agent) ? entry.agent : null}
                  size={14}
                />
              ))}
              {hidden > 0 ? <span className="text-xs text-muted-foreground">+{hidden}</span> : null}
            </span>
          </>
        }
        slot={<RowSlot model={model} step={HOOK_STEPS} meta={null} />}
      />
      {expanded ? (
        <div className="pl-6">
          {agents.map((entry) => (
            <AgentSubRow key={entry.agent} model={model} entry={entry} />
          ))}
          {scripts ? <HookScriptsSubRow model={model} entry={scripts} /> : null}
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
  const agent = isTuiAgent(entry.agent) ? entry.agent : null
  const running =
    (model.runningStep === 'agent-hooks' && entry.state === 'present') ||
    model.retrying.has(orcaUninstallRetryKey('agent-hooks', entry.agent))
  const kind = getOrcaUninstallSlotKind([entry.state], running)
  return (
    <div className={SUB_ROW_CLASS}>
      <AgentIcon agent={agent} size={14} />
      <span className="min-w-0 break-words">{agent ? getAgentLabel(agent) : entry.agent}</span>
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

// The scripts are what the agents' hook entries run, so they belong to the same row.
const HOOK_STEPS: readonly OrcaUninstallStep[] = ['agent-hooks', 'hook-scripts']

function HookScriptsSubRow({
  model,
  entry
}: {
  model: RowsModel
  entry: OrcaUninstallSimpleEntry
}): React.JSX.Element {
  const t = useTranslate()
  const kind = getOrcaUninstallSlotKind([entry.state], isStepBusy(model, 'hook-scripts'))
  return (
    <div className={SUB_ROW_CLASS}>
      <Folder className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 break-words">
        {t('settings.uninstall.rows.hookScripts', 'Hook scripts')}
      </span>
      <span className={PATH_CLASS}>{entry.location}</span>
      <SubRowSlot
        kind={model.phase === 'idle' ? 'blank' : kind}
        detail={entry.detail}
        action={
          model.phase === 'done' && entry.state === 'error' ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => model.retry({ step: 'hook-scripts' })}
            >
              {t('settings.uninstall.retry', 'Retry')}
            </Button>
          ) : null
        }
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
              defaults={t(
                'settings.uninstall.rows.cliCommand',
                '<cmd>{{name}}</cmd> CLI on your PATH'
              )}
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
      <OrcaUninstallHostRows model={model} />
    </>
  )
}
