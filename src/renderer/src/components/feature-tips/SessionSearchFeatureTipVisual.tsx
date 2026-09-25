import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { Files, GitBranch, ListChecks, PanelRight } from 'lucide-react'
import { AI_VAULT_AGENT_LABELS, AI_VAULT_AGENTS } from '../../../../shared/ai-vault-types'
import {
  getLocalExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import { usePrefersReducedMotion } from '@/components/feature-wall/feature-wall-modal-helpers'
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
import {
  getSessionSearchDemoRecentRows,
  getSessionSearchDemoScenes,
  type SessionSearchDemoRow
} from './session-search-feature-tip-demo'

type DemoPhase = 'idle' | 'typing' | 'searching' | 'results' | 'focused' | 'erasing'
type DemoState = { scene: number; phase: DemoPhase; chars: number }

const IDLE_MS = 1100
const TYPE_MS = 65
const SEARCHING_MS = 550
const RESULTS_MS = 1300
const FOCUSED_MS = 2200
const ERASE_MS = 24
const ROW_STAGGER_MS = 90

function noop(): void {}

function nextDemoState(state: DemoState, queryLength: number, sceneCount: number): DemoState {
  switch (state.phase) {
    case 'idle':
      return { ...state, phase: 'typing', chars: 0 }
    case 'typing':
      return state.chars < queryLength
        ? { ...state, chars: state.chars + 1 }
        : { ...state, phase: 'searching' }
    case 'searching':
      return { ...state, phase: 'results' }
    case 'results':
      return { ...state, phase: 'focused' }
    case 'focused':
      return { ...state, phase: 'erasing' }
    case 'erasing':
      return state.chars > 0
        ? { ...state, chars: state.chars - 1 }
        : { scene: (state.scene + 1) % sceneCount, phase: 'idle', chars: 0 }
  }
}

function demoStepDelay(state: DemoState, queryLength: number): number {
  switch (state.phase) {
    case 'idle':
      return IDLE_MS
    case 'typing':
      return state.chars < queryLength ? TYPE_MS : TYPE_MS * 2
    case 'searching':
      return SEARCHING_MS
    case 'results':
      return RESULTS_MS
    case 'focused':
      return FOCUSED_MS
    case 'erasing':
      return ERASE_MS
  }
}

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

function DemoSessionRow({
  row,
  isHit,
  focused,
  index
}: {
  row: SessionSearchDemoRow
  isHit: boolean
  focused: boolean
  index: number
}): JSX.Element {
  return (
    <div
      data-testid="session-search-demo-row"
      data-focused={focused}
      className="flex flex-col border-b border-sidebar-border px-3 py-2 transition-colors duration-300 animate-in fade-in-0 slide-in-from-bottom-1 [animation-fill-mode:both] data-[focused=true]:bg-sidebar-accent/55 motion-reduce:animate-none"
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
    </div>
  )
}

export function SessionSearchFeatureTipVisual(): JSX.Element {
  const reducedMotion = usePrefersReducedMotion()
  const scenes = getSessionSearchDemoScenes()
  const recentRows = getSessionSearchDemoRecentRows()
  const [state, setState] = useState<DemoState>({ scene: 0, phase: 'idle', chars: 0 })
  // Why: reduced motion freezes on the first answered search instead of looping.
  const shown: DemoState = reducedMotion
    ? { scene: 0, phase: 'results', chars: scenes[0].query.length }
    : state
  const scene = scenes[shown.scene]
  const queryLength = scene.query.length

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const timeoutId = window.setTimeout(
      () => setState((current) => nextDemoState(current, queryLength, scenes.length)),
      demoStepDelay(state, queryLength)
    )
    return () => window.clearTimeout(timeoutId)
  }, [queryLength, reducedMotion, scenes.length, state])

  const showingHits =
    shown.phase === 'results' || shown.phase === 'focused' || shown.phase === 'erasing'
  const rows = showingHits ? scene.hits : recentRows
  const dimmed =
    shown.phase === 'typing' || shown.phase === 'searching' || shown.phase === 'erasing'

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
          query={scene.query.slice(0, shown.chars)}
          searching={shown.chars > 0}
          loading={shown.phase === 'searching'}
          hasScanResult
          activeWorktreePath="/demo"
          activeProjectKey="demo"
          scope="all"
          executionHostScope={LOCAL_EXECUTION_HOST_ID}
          hostScopeOptions={[{ id: LOCAL_EXECUTION_HOST_ID, label: getLocalExecutionHostLabel() }]}
          agents={AI_VAULT_AGENTS}
          group={DEFAULT_AI_VAULT_GROUP}
          hideEmptySessions={DEFAULT_AI_VAULT_HIDE_EMPTY_SESSIONS}
          sessionLimit={DEFAULT_AI_VAULT_SESSION_LIMIT}
          adjustmentCount={0}
          onQueryChange={noop}
          onScopeChange={noop}
          onExecutionHostScopeChange={noop}
          onAgentEnabledChange={noop}
          onAllAgentsEnabledChange={noop}
          onGroupChange={noop}
          onHideEmptySessionsChange={noop}
          onSessionLimitChange={noop}
          onReset={noop}
          onRefresh={noop}
        />
        <div
          key={showingHits ? `hits-${shown.scene}` : 'recent'}
          data-dimmed={dimmed}
          className="min-h-0 flex-1 overflow-hidden transition-opacity duration-200 data-[dimmed=true]:opacity-45"
        >
          {rows.map((row, index) => (
            <DemoSessionRow
              key={row.title}
              row={row}
              isHit={showingHits}
              focused={shown.phase === 'focused' && index === 0}
              index={index}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-sidebar to-transparent" />
      </div>
    </div>
  )
}
