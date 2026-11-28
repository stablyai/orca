import { Bell, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { AgentStateDot, type AgentDotState } from '@/components/agent/status/AgentStateDot'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { AgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'

export type AgentHookConsentSlideId =
  | 'status'
  | 'sidebar'
  | 'notification'
  | 'waiting'
  | 'subagents'
  | 'rename'
  | 'approvals'

// Agents that report their own state over OSC 7501, so Orca has a state for them without hooks.
const SELF_REPORTING_AGENTS = new Set<AgentHookTarget>(['claude', 'codex', 'grok', 'kimi', 'kiro'])

/** Only what hooks really add for this agent, most visible first. */
export function agentHookConsentSlides(agent: AgentHookTarget): AgentHookConsentSlideId[] {
  if (agent === 'claude') {
    return ['sidebar', 'notification', 'subagents', 'rename', 'approvals']
  }
  if (agent === 'codex') {
    return ['sidebar', 'notification', 'waiting', 'rename']
  }
  return SELF_REPORTING_AGENTS.has(agent)
    ? ['sidebar', 'notification', 'rename']
    : ['status', 'sidebar', 'notification', 'rename']
}

/** One line of the sidebar's CompactAgentRow, drawn without live data. */
function SampleAgentRow({
  agent,
  state,
  lead,
  trail,
  child = false,
  age
}: {
  agent: AgentHookTarget
  state: AgentDotState | null
  lead: string
  trail?: string
  child?: boolean
  age: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-6 min-w-0 items-center gap-1 rounded-sm px-1 text-[11px] leading-none',
        child ? 'pl-5' : 'bg-worktree-sidebar-accent'
      )}
    >
      {state ? (
        <AgentStateDot state={state} size="sm" title={null} />
      ) : (
        <span className="size-2.5" />
      )}
      {child ? null : <AgentTypeIcon agentType={agent} size={13} />}
      <span className="min-w-0 flex-1 truncate">
        <span className={child ? 'text-muted-foreground/90' : 'text-foreground'}>{lead}</span>
        {trail ? <span className="text-muted-foreground/80"> - {trail}</span> : null}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">{age}</span>
    </div>
  )
}

function SampleSidebar({
  workspace,
  children
}: {
  workspace?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-1 py-1">
      {workspace ? (
        <div className="truncate px-1 pb-1 text-xs font-medium text-foreground">{workspace}</div>
      ) : null}
      {children}
    </div>
  )
}

function SampleNotification({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[24px_1fr] items-start gap-2 rounded-lg border border-border bg-background/60 px-2 py-1.5 text-xs leading-snug shadow-xs">
      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Bell className="size-3.5" />
      </span>
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{title}</div>
        <div className="line-clamp-2 text-muted-foreground">{body}</div>
      </div>
    </div>
  )
}

function SampleApproval({
  agent,
  preview,
  asking,
  worker
}: {
  agent: AgentHookTarget
  worker: string
  preview: string
  asking: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar px-2 py-1.5 text-xs">
      <AgentTypeIcon agentType={agent} size={14} />
      <div className="min-w-0">
        <div className="font-medium text-foreground">{worker}</div>
        <div
          className={cn('truncate', asking ? 'text-agent-question-text' : 'text-muted-foreground')}
        >
          {preview}
        </div>
      </div>
    </div>
  )
}

type SlideContent = { caption: string; effect: string | null; now: ReactNode; withHooks: ReactNode }

function slideContent(
  id: AgentHookConsentSlideId,
  agent: AgentHookTarget,
  t: Translate
): SlideContent {
  const name = formatAgentTypeLabel(agent)
  const prompt = t('agentHookConsent.sample.prompt', 'Fix the login flake')
  const workspace = 'fix-login-flake'
  const age = t('agentHookConsent.sample.age', '2m')
  const worker = t('agentHookConsent.sample.worker', 'worker-2')
  // Claude names its task over OSC 7501 even without hooks; other agents leave only their name.
  const fallbackTrail =
    agent === 'claude' ? t('agentHookConsent.sample.claudeSummary', 'Fixing the login test') : name
  switch (id) {
    case 'status':
      return {
        caption: t('agentHookConsent.slide.status', 'Status you can trust'),
        effect: t('agentHookConsent.slide.statusEffect', 'working, needs you, done'),
        now: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow age={age} agent={agent} state={null} lead={name} />
          </SampleSidebar>
        ),
        withHooks: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="waiting"
              lead={prompt}
              trail={t('agentHookConsent.sample.question', 'Run pnpm install?')}
            />
          </SampleSidebar>
        )
      }
    case 'sidebar':
      return {
        caption: t('agentHookConsent.slide.sidebar', 'Richer sidebar'),
        effect: t('agentHookConsent.slide.sidebarEffect', 'your prompt and its current step'),
        now: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={t('agentHookConsent.sample.working', 'Working')}
              trail={fallbackTrail}
            />
          </SampleSidebar>
        ),
        withHooks: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={prompt}
              trail="Bash: pnpm test"
            />
          </SampleSidebar>
        )
      }
    case 'notification': {
      const title = t(
        'agentHookConsent.sample.notificationTitle',
        'orca / {{workspace}} - {{agent}} finished',
        {
          workspace,
          agent: name
        }
      )
      return {
        caption: t('agentHookConsent.slide.notification', 'Notifications in its own words'),
        effect: null,
        now: (
          <SampleNotification
            title={title}
            body={t('agentHookConsent.sample.notificationFallback', '{{agent}} finished.', {
              agent: name
            })}
          />
        ),
        withHooks: (
          <SampleNotification
            title={title}
            body={t(
              'agentHookConsent.sample.notificationReply',
              'Tests pass. The race was in session refresh; I added a lock and a regression test.'
            )}
          />
        )
      }
    }
    case 'waiting':
      return {
        caption: t('agentHookConsent.slide.waiting', 'Know what it’s waiting on'),
        effect: null,
        now: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="waiting"
              lead={t('agentHookConsent.sample.waiting', 'Waiting')}
              trail={name}
            />
          </SampleSidebar>
        ),
        withHooks: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="waiting"
              lead={prompt}
              trail="Bash: pnpm install"
            />
          </SampleSidebar>
        )
      }
    case 'subagents':
      return {
        caption: t('agentHookConsent.slide.subagents', 'Every subagent gets a row'),
        effect: null,
        now: (
          <SampleSidebar>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={t('agentHookConsent.sample.working', 'Working')}
              trail={fallbackTrail}
            />
          </SampleSidebar>
        ),
        withHooks: (
          <SampleSidebar>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={prompt}
              trail={t('agentHookConsent.sample.subagentCount', '2 agents')}
            />
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={t('agentHookConsent.sample.subagentOne', 'Explore auth tests')}
              child
            />
            <SampleAgentRow
              age={age}
              agent={agent}
              state="done"
              lead={t('agentHookConsent.sample.subagentTwo', 'Review session refresh')}
              child
            />
          </SampleSidebar>
        )
      }
    case 'rename':
      return {
        caption: t('agentHookConsent.slide.rename', 'Auto-named workspaces'),
        effect: t('agentHookConsent.slide.renameEffect', 'from your first prompt'),
        now: (
          <SampleSidebar workspace="lungfish-3">
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={t('agentHookConsent.sample.working', 'Working')}
              trail={fallbackTrail}
            />
          </SampleSidebar>
        ),
        withHooks: (
          <SampleSidebar workspace={workspace}>
            <SampleAgentRow
              age={age}
              agent={agent}
              state="working"
              lead={prompt}
              trail="Bash: pnpm test"
            />
          </SampleSidebar>
        )
      }
    case 'approvals':
      return {
        caption: t('agentHookConsent.slide.approvals', 'Approvals reach your coordinator'),
        effect: null,
        now: <SampleApproval worker={worker} agent={agent} preview={prompt} asking={false} />,
        withHooks: (
          <SampleApproval
            worker={worker}
            agent={agent}
            preview={t(
              'agentHookConsent.sample.approval',
              'Waiting for your approval: Bash: pnpm install'
            )}
            asking
          />
        )
      }
  }
}

/** One carousel slide: the effect on top, then what Orca shows now and with hooks. */
export function AgentHookConsentSlide({
  id,
  agent,
  t
}: {
  id: AgentHookConsentSlideId
  agent: AgentHookTarget
  t: Translate
}): React.JSX.Element {
  const slide = slideContent(id, agent, t)
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-3 py-2.5">
      <p className="truncate text-[13px] font-medium text-popover-foreground">
        {slide.caption}
        {slide.effect ? (
          <span className="font-normal text-muted-foreground">: {slide.effect}</span>
        ) : null}
      </p>
      <div className="flex flex-col gap-1.5">
        <div>
          <div className="mb-1 text-2xs text-muted-foreground">
            {t('agentHookConsent.now', 'Now')}
          </div>
          {slide.now}
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 text-2xs font-medium text-popover-foreground">
            <Sparkles className="size-3" />
            {t('agentHookConsent.withHooks', 'With hooks')}
          </div>
          {slide.withHooks}
        </div>
      </div>
    </div>
  )
}
