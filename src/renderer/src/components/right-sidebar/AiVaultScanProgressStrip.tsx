import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { Progress } from '@/components/ui/progress'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useNow } from '@/hooks/use-now'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type {
  AiVaultScanAgentProgress,
  AiVaultScanProgress
} from '../../../../shared/ai-vault-scan-progress'
import { agentLabel } from './ai-vault-session-filters'
import { formatTimeAgo } from './ai-vault-session-time'

// Why: interpolated so locales place the emphasized count; U+0000 never appears in copy.
const EMPHASIS_TOKEN = '\u0000'
type StripActivity = { progress: AiVaultScanProgress; active: boolean }

function formatCount(value: number): string {
  return value.toLocaleString(getIntlLocale())
}

function fileCountLabel(count: number): string {
  const value0 = formatCount(count)
  return count === 1
    ? translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.fileCount_one',
        '{{value0}} file',
        { value0 }
      )
    : translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.fileCount_other',
        '{{value0}} files',
        { value0 }
      )
}

function databaseCountLabel(count: number): string {
  const value0 = formatCount(count)
  return count === 1
    ? translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.databaseCount_one',
        '{{value0}} database',
        { value0 }
      )
    : translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.databaseCount_other',
        '{{value0}} databases',
        { value0 }
      )
}

function stripSentence(progress: AiVaultScanProgress): string {
  const value0 = EMPHASIS_TOKEN
  switch (progress.stage) {
    case 'finding':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.scanning',
        'Scanning {{value0}}',
        { value0 }
      )
    case 'reading':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.checking',
        'Checking {{value0}}',
        { value0 }
      )
    case 'finished':
      return translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.scanned',
        'Scanned {{value0}}',
        { value0 }
      )
  }
}

function foundCount(agent: AiVaultScanAgentProgress): number {
  return agent.files + agent.databases
}

function StripText({ progress, active }: StripActivity): React.JSX.Element {
  const emphasis =
    active && progress.stage === 'reading'
      ? `${formatCount(progress.read.done + (progress.read.skipped ?? 0))} / ${formatCount(progress.read.total)}`
      : fileCountLabel(progress.agents.reduce((sum, agent) => sum + foundCount(agent), 0))
  const sentence =
    active || progress.stage === 'finished' ? stripSentence(progress) : EMPHASIS_TOKEN
  const [before, after] = sentence.split(EMPHASIS_TOKEN)
  return (
    <span className="min-w-0 truncate">
      {before}
      <span className="font-medium text-foreground">{emphasis}</span>
      {after}
    </span>
  )
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// The strip stays muted; status colour lives only in the per-agent rows.
function StripMark({ progress, active }: StripActivity): React.JSX.Element | null {
  if (active) {
    return <LoadingSpinner className="size-3 shrink-0" />
  }
  return progress.stage === 'finished' ? <Check className="size-3 shrink-0" /> : null
}

function agentDetail(agent: AiVaultScanAgentProgress): string {
  if (agent.databases > 0) {
    const databases = databaseCountLabel(agent.databases)
    return agent.files > 0 ? `${fileCountLabel(agent.files)} · ${databases}` : databases
  }
  return fileCountLabel(agent.files)
}

function AgentRow({
  agent,
  current,
  progress,
  active
}: {
  agent: AiVaultScanAgentProgress
  current: boolean
} & StripActivity): React.JSX.Element {
  const read = current && progress.stage !== 'finding' ? agent.read : undefined
  const settled = read ? read.done + (read.skipped ?? 0) : 0
  const hasWork = read !== undefined && read.total > 0
  const showBar = hasWork && (active || progress.stage === 'finished')
  const complete = showBar && settled === read.total
  const label = agentLabel(agent.agent)
  const checked = hasWork
    ? translate(
        'auto.components.right.sidebar.AiVaultScanProgressStrip.agentChecked',
        '{{agent}}: {{settled}} of {{total}} history candidates checked',
        { agent: label, settled: formatCount(settled), total: formatCount(read.total) }
      )
    : undefined
  return (
    <div role="listitem" className="px-3 py-1.5 text-xs">
      <div className="flex h-5 items-center gap-2">
        <AgentIcon agent={agent.agent} size={14} />
        <span className="min-w-0 truncate text-foreground">{label}</span>
        <span
          className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums"
          aria-label={checked}
        >
          {hasWork ? `${formatCount(settled)} / ${formatCount(read.total)}` : agentDetail(agent)}
        </span>
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {complete ? (
            <Check className="size-3.5 text-status-success" />
          ) : current && active ? (
            <LoadingSpinner className="size-3.5 text-muted-foreground" />
          ) : null}
        </span>
      </div>
      <div className="mt-1 h-1 pl-5.5">
        {showBar && (
          <Progress
            value={(settled / read.total) * 100}
            aria-label={checked}
            aria-valuetext={checked}
            className="h-1"
          />
        )}
      </div>
    </div>
  )
}

/** One line under the search box naming what this computer's scan is doing; opens to one row per agent. */
export function AiVaultScanProgressStrip({
  progress,
  agents = progress.agents,
  active = progress.settledAt === null
}: {
  progress: AiVaultScanProgress
  agents?: AiVaultScanAgentProgress[]
  active?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const finished = progress.stage === 'finished'
  const now = useNow(active ? 1_000 : 30_000, active || finished)
  const elapsedAt = active ? now : progress.settledAt
  const time =
    finished && progress.settledAt !== null
      ? formatTimeAgo(progress.settledAt)
      : elapsedAt !== null
        ? formatElapsed(elapsedAt - progress.startedAt)
        : null
  return (
    <div className={cn('shrink-0 border-b border-sidebar-border', open && 'bg-sidebar-accent/35')}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex h-8 w-full cursor-pointer items-center gap-1.5 pl-3 pr-2 text-left text-2xs text-muted-foreground tabular-nums outline-none hover:bg-sidebar-accent/50 focus-visible:ring-[2px] focus-visible:ring-sidebar-ring/30"
          >
            <StripMark progress={progress} active={active} />
            <StripText progress={progress} active={active} />
            <span className="ml-auto shrink-0">{time}</span>
            <ChevronDown
              className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div role="list" className="py-1">
            {agents.map((agent) => (
              <AgentRow
                key={agent.agent}
                agent={agent}
                current={progress.agents.includes(agent)}
                progress={progress}
                active={active}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
