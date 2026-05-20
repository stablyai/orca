import React from 'react'
import { AgentStateDot, agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

type AgentHoverSectionProps = {
  title: string
  children: React.ReactNode
}

function AgentHoverSection({ title, children }: AgentHoverSectionProps): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {title}
      </div>
      <div className="text-[12px] leading-relaxed text-popover-foreground">{children}</div>
    </section>
  )
}

type DashboardAgentHoverCardContentProps = {
  agent: DashboardAgentRowData
  dotState: AgentDotState
  prompt: string
  isWorking: boolean
  toolName: string
  toolInput: string
  lastAssistantMessage: string
  tsParts: readonly string[]
}

export function DashboardAgentHoverCardContent({
  agent,
  dotState,
  prompt,
  isWorking,
  toolName,
  toolInput,
  lastAssistantMessage,
  tsParts
}: DashboardAgentHoverCardContentProps): React.JSX.Element {
  const agentLabel = formatAgentTypeLabel(agent.agentType)
  const statusLabel = agent.entry.interrupted ? 'Interrupted' : agentStateLabel(dotState)
  const hasToolDetails = isWorking && (toolName.length > 0 || toolInput.length > 0)
  const hasBodyDetails = prompt.length > 0 || hasToolDetails || lastAssistantMessage.length > 0

  return (
    <div
      className="max-h-[min(70vh,520px)] overflow-y-auto"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <AgentStateDot state={dotState} size="md" />
          <span className="inline-flex shrink-0 text-foreground">
            <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-popover-foreground">
              {agentLabel}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {[statusLabel, ...tsParts].join(' • ')}
            </div>
          </div>
          {agent.entry.interrupted && (
            <span className="shrink-0 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive">
              interrupted
            </span>
          )}
        </div>
      </div>
      <div className="space-y-3 px-3 py-3">
        {prompt && (
          <AgentHoverSection title="Prompt">
            <CommentMarkdown
              content={prompt}
              variant="document"
              className="text-[12px] leading-relaxed"
            />
          </AgentHoverSection>
        )}
        {hasToolDetails && (
          <AgentHoverSection title="Current tool">
            <div className="space-y-1.5">
              {toolName && (
                <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground">
                  {toolName}
                </code>
              )}
              {toolInput && (
                <pre className="max-h-40 overflow-auto rounded-md bg-accent p-2 font-mono text-[11px] leading-snug text-accent-foreground [overflow-wrap:anywhere]">
                  {toolInput}
                </pre>
              )}
            </div>
          </AgentHoverSection>
        )}
        {lastAssistantMessage && (
          <AgentHoverSection title="Latest message">
            <CommentMarkdown
              content={lastAssistantMessage}
              variant="document"
              className="text-[12px] leading-relaxed"
            />
          </AgentHoverSection>
        )}
        {!hasBodyDetails && (
          <div className="text-xs text-muted-foreground">No agent details yet.</div>
        )}
      </div>
    </div>
  )
}
