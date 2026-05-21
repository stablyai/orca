import React from 'react'
import { ArrowRight, Check, Copy } from 'lucide-react'
import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { WORKTREE_CONTEXT_MENU_SCOPE_ATTR } from '@/components/sidebar/worktree-context-menu-scope'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from './useDashboardData'

type AgentHoverSectionProps = {
  title: string
  children: React.ReactNode
  copyLabel?: string
  copied?: boolean
  onCopy?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

function AgentHoverSection({
  title,
  children,
  copyLabel,
  copied = false,
  onCopy
}: AgentHoverSectionProps): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {title}
        </div>
        {onCopy && copyLabel && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-5 text-muted-foreground hover:text-foreground"
                onClick={onCopy}
                onMouseDown={(event) => event.stopPropagation()}
                aria-label={copyLabel}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {copied ? 'Copied' : copyLabel}
            </TooltipContent>
          </Tooltip>
        )}
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
  headerTimestamp: string | null
  onActivate: (event: React.SyntheticEvent) => void
}

export function DashboardAgentHoverCardContent({
  agent,
  dotState,
  prompt,
  isWorking,
  toolName,
  toolInput,
  lastAssistantMessage,
  headerTimestamp,
  onActivate
}: DashboardAgentHoverCardContentProps): React.JSX.Element {
  const copyResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copiedSection, setCopiedSection] = React.useState<'prompt' | 'latest' | null>(null)
  const agentLabel = formatAgentTypeLabel(agent.agentType)
  const hasToolDetails = isWorking && (toolName.length > 0 || toolInput.length > 0)
  const hasBodyDetails = prompt.length > 0 || hasToolDetails || lastAssistantMessage.length > 0
  const copySectionText = React.useCallback((section: 'prompt' | 'latest', text: string) => {
    return async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      await window.api.ui.writeClipboardText(text)
      setCopiedSection(section)
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = setTimeout(() => setCopiedSection(null), 1200)
    }
  }, [])
  const handleHeaderKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onActivate(event)
    },
    [onActivate]
  )

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        clearTimeout(copyResetTimerRef.current)
      }
    }
  }, [])

  return (
    <div
      className="flex max-h-[min(70vh,520px)] flex-col"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenuCapture={(event) => event.stopPropagation()}
      {...{ [WORKTREE_CONTEXT_MENU_SCOPE_ATTR]: 'agent-hover-card' }}
    >
      <div
        role="button"
        tabIndex={0}
        className="group/header flex h-10 shrink-0 cursor-pointer items-center border-b border-border/60 bg-popover px-3 text-left transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={onActivate}
        onKeyDown={handleHeaderKeyDown}
      >
        <div className="flex min-w-0 w-full items-center gap-2">
          <AgentStateDot state={dotState} size="md" />
          <span className="inline-flex size-4 shrink-0 items-center justify-center text-foreground">
            <AgentIcon agent={agentTypeToIconAgent(agent.agentType)} size={16} />
          </span>
          <div className="min-w-0 flex-1 truncate text-sm font-semibold leading-4 text-popover-foreground">
            {agentLabel}
          </div>
          {agent.entry.interrupted && (
            <span className="shrink-0 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive">
              interrupted
            </span>
          )}
          <span className="ml-auto grid shrink-0 grid-cols-1 grid-rows-1 items-center justify-items-end">
            {headerTimestamp && (
              <span className="[grid-area:1/1] text-xs font-normal text-muted-foreground transition-opacity group-hover/header:opacity-0">
                {headerTimestamp}
              </span>
            )}
            <span className="[grid-area:1/1] inline-flex items-center gap-1 text-xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover/header:opacity-100">
              <ArrowRight className="size-3" />
              Open
            </span>
          </span>
        </div>
      </div>
      <ScrollArea
        className="min-h-0 max-h-[calc(min(70vh,520px)-2.5rem)] flex-1"
        viewportClassName="max-h-[calc(min(70vh,520px)-2.5rem)]"
        type="auto"
        scrollbars="both"
      >
        <div className="min-w-full space-y-3 px-3 py-3 [&_pre]:max-w-none [&_table]:min-w-max">
          {prompt && (
            <AgentHoverSection
              title="Prompt"
              copyLabel="Copy prompt"
              copied={copiedSection === 'prompt'}
              onCopy={copySectionText('prompt', prompt)}
            >
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
                  <pre className="whitespace-pre rounded-md bg-accent p-2 font-mono text-[11px] leading-snug text-accent-foreground">
                    {toolInput}
                  </pre>
                )}
              </div>
            </AgentHoverSection>
          )}
          {lastAssistantMessage && (
            <AgentHoverSection
              title="Latest message"
              copyLabel="Copy latest message"
              copied={copiedSection === 'latest'}
              onCopy={copySectionText('latest', lastAssistantMessage)}
            >
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
      </ScrollArea>
    </div>
  )
}
