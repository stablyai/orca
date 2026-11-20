import { Check, Clock, FileText, LoaderCircle, MessageSquare, ShieldCheck, X } from 'lucide-react'
import type {
  AgentMapNode,
  AgentMapNodeViewState
} from '../../../../shared/agent-session-map/agent-session-map-model'
import { formatAgentMapDuration } from '../../../../shared/agent-session-map/agent-session-map-duration'
import { AGENT_MAP_STATUS_COLORS, agentMapStatusLabel } from './agent-session-map-status-color'
import { translate } from '@/i18n/i18n'

/** The inspection panel for one node: provenance, every tool call with timings,
 *  turns, the questions/approvals it raised, and the files it touched. */
export function AgentSessionMapDetail({
  node,
  view,
  onClose
}: {
  node: AgentMapNode
  view: AgentMapNodeViewState
  onClose: () => void
}) {
  const t = translate
  const statusColor = AGENT_MAP_STATUS_COLORS[view.status]
  const durationMs = node.lastTs - node.firstTs

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-background">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: statusColor.stroke }}
            />
            <h3 className="truncate text-sm font-semibold text-foreground">{node.label}</h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {node.kind === 'main'
              ? t('components.agentSessionMap.node.mainAgent', 'Main agent')
              : t('components.agentSessionMap.node.subagent', 'Sub-agent')}
            {' · '}
            {agentMapStatusLabel(view.status)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('components.agentSessionMap.detail.close', 'Close details')}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Stat label={t('components.agentSessionMap.detail.duration', 'Duration')}>
            {formatAgentMapDuration(durationMs)}
          </Stat>
          <Stat label={t('components.agentSessionMap.detail.tools', 'Tool calls')}>
            {view.toolCount}
            {view.failedToolCount > 0 && (
              <span className="text-destructive"> ({view.failedToolCount}✗)</span>
            )}
          </Stat>
          <Stat label={t('components.agentSessionMap.detail.prompts', 'Prompts')}>
            {view.promptCount}
          </Stat>
          <Stat label={t('components.agentSessionMap.detail.files', 'Files touched')}>
            {node.filesTouched.length}
          </Stat>
        </dl>
        {view.lastStatusText && (
          <p className="mt-3 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
            {view.lastStatusText}
          </p>
        )}
        {node.lastPromptText && (
          <Section title={t('components.agentSessionMap.detail.lastPrompt', 'Last prompt')}>
            <p className="text-xs text-foreground">{node.lastPromptText}</p>
          </Section>
        )}
        {node.requests.length > 0 && (
          <Section
            title={t(
              'components.agentSessionMap.detail.requests',
              'Questions & approvals ({{count}})',
              { count: node.requests.length }
            )}
          >
            <ul className="space-y-1.5">
              {node.requests.map((request) => (
                <li key={request.itemId} className="flex items-start gap-1.5 text-xs">
                  {request.kind === 'question' ? (
                    <MessageSquare size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ShieldCheck size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 break-words text-foreground">
                    {request.detail ??
                      (request.kind === 'question'
                        ? t('components.agentSessionMap.detail.question', 'Question')
                        : t('components.agentSessionMap.detail.approval', 'Approval'))}
                    <span
                      className={
                        request.resolution === 'pending'
                          ? 'text-status-warning'
                          : request.resolution === 'resolved'
                            ? 'text-status-success'
                            : 'text-muted-foreground'
                      }
                    >
                      {' · '}
                      {t(
                        `components.agentSessionMap.detail.resolution.${request.resolution}`,
                        request.resolution
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {node.toolCalls.length > 0 && (
          <Section
            title={t('components.agentSessionMap.detail.toolCalls', 'Tool calls ({{count}})', {
              count: node.toolCalls.length
            })}
          >
            <ul className="space-y-1">
              {node.toolCalls.map((call) => (
                <li key={call.callId} className="flex items-center gap-1.5 text-xs">
                  {call.state === 'running' ? (
                    <LoaderCircle size={12} className="shrink-0 animate-spin text-primary" />
                  ) : call.state === 'completed' ? (
                    <Check size={12} className="shrink-0 text-status-success" />
                  ) : (
                    <X size={12} className="shrink-0 text-destructive" />
                  )}
                  <span className="shrink-0 font-mono text-foreground">{call.name}</span>
                  {call.summary && (
                    <span className="min-w-0 truncate text-muted-foreground">{call.summary}</span>
                  )}
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {call.durationMs !== undefined ? formatAgentMapDuration(call.durationMs) : '…'}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {node.turns.length > 0 && (
          <Section
            title={t('components.agentSessionMap.detail.turns', 'Turns ({{count}})', {
              count: node.turns.length
            })}
          >
            <ul className="space-y-1">
              {node.turns.map((turn) => (
                <li
                  key={turn.turnId}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Clock size={12} className="shrink-0" />
                  <span className="text-foreground">
                    {t(`components.agentSessionMap.detail.turnState.${turn.state}`, turn.state)}
                  </span>
                  {turn.durationMs !== undefined && (
                    <span className="ml-auto tabular-nums">
                      {formatAgentMapDuration(turn.durationMs)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {node.filesTouched.length > 0 && (
          <Section
            title={t(
              'components.agentSessionMap.detail.filesTouched',
              'Files touched ({{count}})',
              { count: node.filesTouched.length }
            )}
          >
            <ul className="space-y-0.5">
              {node.filesTouched.map((path) => (
                <li key={path} className="flex items-center gap-1.5 text-xs">
                  <FileText size={12} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono text-foreground" title={path}>
                    {path}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </aside>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{children}</dd>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  )
}
