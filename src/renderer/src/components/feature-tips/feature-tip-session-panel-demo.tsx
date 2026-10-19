import type { JSX, ReactNode } from 'react'
import { Files, GitBranch, ListChecks, PanelRight } from 'lucide-react'
import { AI_VAULT_AGENT_LABELS, AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import {
  getLocalExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { AgentSessionHistoryIcon } from '@/components/right-sidebar/agent-session-history-icon'
import { AiVaultPanelHeader } from '@/components/right-sidebar/AiVaultPanelHeader'
import { highlightedSearchSnippet } from '@/components/right-sidebar/AiVaultSearchEvidence'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '@/components/right-sidebar/ai-vault-session-limit'
import {
  DEFAULT_AI_VAULT_GROUP,
  DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS
} from '@/components/right-sidebar/ai-vault-view-defaults'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { SessionSearchDemoRow } from './session-search-feature-tip-demo'

const ROW_STAGGER_MS = 90

function noop(): void {}

// The real panel header, inert, with everything but the query held still.
const DEMO_HEADER_PROPS = {
  hasScanResult: true,
  activeWorktreePath: '/demo',
  activeProjectKey: 'demo',
  scope: 'all',
  executionHostScope: LOCAL_EXECUTION_HOST_ID,
  hostScopeOptions: [{ id: LOCAL_EXECUTION_HOST_ID, label: getLocalExecutionHostLabel() }],
  agents: AI_VAULT_AGENTS,
  group: DEFAULT_AI_VAULT_GROUP,
  hideEmptySessions: DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS,
  sessionLimit: DEFAULT_AI_VAULT_SESSION_LIMIT,
  adjustmentCount: 0,
  onQueryChange: noop,
  onScopeChange: noop,
  onExecutionHostScopeChange: noop,
  onAgentEnabledChange: noop,
  onAllAgentsEnabledChange: noop,
  onGroupChange: noop,
  onHideEmptySessionsChange: noop,
  onSessionLimitChange: noop,
  onReset: noop,
  onRefresh: noop
} as const

function DemoActivityTab({
  active = false,
  children
}: {
  active?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <span
      data-active={active}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground"
    >
      {children}
    </span>
  )
}

// Mirrors the right sidebar's tab row so the tip shows where the panel lives.
function DemoActivityStrip(): JSX.Element {
  return (
    <div className="flex h-10 items-center gap-1 border-b border-sidebar-border px-2">
      <DemoActivityTab>
        <Files className="size-4" />
      </DemoActivityTab>
      <DemoActivityTab active>
        <AgentSessionHistoryIcon size={16} />
      </DemoActivityTab>
      <DemoActivityTab>
        <GitBranch className="size-4" />
      </DemoActivityTab>
      <DemoActivityTab>
        <ListChecks className="size-4" />
      </DemoActivityTab>
      <span className="flex-1" />
      <DemoActivityTab>
        <PanelRight className="size-4" />
      </DemoActivityTab>
    </div>
  )
}

/** The right sidebar's Agent Session History panel, inert, for a feature tip visual. */
export function DemoSessionPanel({
  query = '',
  searching = false,
  loading = false,
  children
}: {
  query?: string
  searching?: boolean
  loading?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className="relative flex h-full min-h-[23rem] flex-col items-center justify-center overflow-hidden px-6 py-7"
      aria-hidden="true"
    >
      {/* Why: the real panel header is interactive; inert keeps its controls out of the tab order. */}
      <div
        inert
        className="@container/ai-vault relative flex h-[22rem] w-full max-w-[22rem] flex-col overflow-hidden rounded-xl border border-border/80 bg-sidebar text-left shadow-xs"
      >
        <DemoActivityStrip />
        <AiVaultPanelHeader
          {...DEMO_HEADER_PROPS}
          query={query}
          searching={searching}
          loading={loading}
        />
        {children}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sidebar to-transparent" />
      </div>
    </div>
  )
}

export function DemoSessionRow({
  row,
  isHit,
  focused,
  index,
  children
}: {
  row: SessionSearchDemoRow
  isHit: boolean
  focused: boolean
  index: number
  /** Overlays anchored to the row, such as its actions menu. */
  children?: ReactNode
}): JSX.Element {
  return (
    <div
      data-focused={focused}
      className="relative flex flex-col border-b border-sidebar-border px-3 py-2 transition-colors duration-300 animate-in fade-in-0 slide-in-from-bottom-1 [animation-fill-mode:both] data-[focused=true]:z-10 data-[focused=true]:bg-sidebar-accent/55 motion-reduce:animate-none"
      style={{ animationDelay: `${index * ROW_STAGGER_MS}ms` }}
    >
      <div className="line-clamp-1 text-[13px] font-medium leading-5 text-foreground">
        {row.title}
      </div>
      <div className="mt-0.5 line-clamp-2 text-[12px] leading-4 text-muted-foreground">
        <span className="font-medium text-foreground/80">{row.role}</span>
        <span>: {isHit ? highlightedSearchSnippet(row.text) : row.text}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
        <AgentIcon agent={row.agent} size={14} />
        <span className="truncate">{AI_VAULT_AGENT_LABELS[row.agent]}</span>
        <span className="shrink-0 tabular-nums">
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.messageCount',
            '{{value0}} msgs',
            { value0: row.messages }
          )}
        </span>
        <span className="shrink-0 text-muted-foreground/55">·</span>
        <span className="shrink-0">{row.age}</span>
      </div>
      {children}
    </div>
  )
}
