import React from 'react'
import {
  GitPullRequest,
  CircleDot,
  GitBranch,
  CheckSquare,
  Square,
  Bot,
  Send,
  ExternalLink,
  ChevronDown
} from 'lucide-react'
import type { AssignedAgentInfo, BacklogItem } from '../../../../shared/backlog-types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type BacklogChecklistViewProps = {
  items: BacklogItem[]
  activeAgents: AssignedAgentInfo[]
  onToggleStatus: (id: string) => void
  onAssignAgent: (id: string, agent: AssignedAgentInfo | undefined) => void
  onDispatch: (item: BacklogItem, agentIndex: number) => void
}

function getItemIcon(kind: BacklogItem['kind']): React.JSX.Element {
  switch (kind) {
    case 'pr':
      return <GitPullRequest className="size-4 text-primary shrink-0" />
    case 'issue':
      return <CircleDot className="size-4 text-muted-foreground shrink-0" />
    case 'branch':
      return <GitBranch className="size-4 text-primary shrink-0" />
    default:
      return <CheckSquare className="size-4 text-primary shrink-0" />
  }
}

function getKindBadge(kind: BacklogItem['kind']): React.JSX.Element {
  switch (kind) {
    case 'pr':
      return (
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-secondary-foreground border border-border">
          PR
        </span>
      )
    case 'issue':
      return (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground border border-border">
          Issue
        </span>
      )
    case 'branch':
      return (
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary border border-primary/20">
          Branch
        </span>
      )
    default:
      return (
        <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground border border-border">
          Task
        </span>
      )
  }
}

export function BacklogChecklistView({
  items,
  activeAgents,
  onToggleStatus,
  onAssignAgent,
  onDispatch
}: BacklogChecklistViewProps): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
        <CheckSquare className="size-10 mb-3 opacity-30" />
        <p className="text-sm font-medium">尚無符合條件的 Backlog 項目</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          點擊上方「新增任務」或重新同步工作階段
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2 max-h-[58vh] overflow-y-auto scrollbar-sleek pr-1">
      {items.map((item) => {
        const isCompleted = item.status === 'completed'
        const isWorking = item.status === 'in_progress'

        return (
          <div
            key={item.id}
            className={`group flex items-center justify-between gap-3 p-2.5 rounded-lg border transition-all duration-150 ${
              isCompleted
                ? 'bg-muted/10 border-border/40 opacity-60 line-through-text'
                : isWorking
                  ? 'bg-primary/5 border-primary/30 shadow-[0_0_12px_rgba(59,130,246,0.06)]'
                  : 'bg-card/40 hover:bg-card/70 border-border/70'
            }`}
          >
            {/* Left: Checkbox + Icon + Title + Metadata */}
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onToggleStatus(item.id)}
                className="shrink-0 text-muted-foreground hover:text-primary transition-colors focus:outline-none"
                title={isCompleted ? '標記為未完成' : '標記為已完成'}
              >
                {isCompleted ? (
                  <CheckSquare className="size-4.5 text-primary fill-primary/20" />
                ) : (
                  <Square className="size-4.5 text-muted-foreground/60 group-hover:text-primary/80" />
                )}
              </button>

              <div className="shrink-0">{getItemIcon(item.kind)}</div>
              <div className="shrink-0">{getKindBadge(item.kind)}</div>

              <div className="min-w-0 flex-1 flex flex-col">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[13px] font-medium truncate ${
                      isCompleted ? 'line-through text-muted-foreground' : 'text-foreground'
                    }`}
                  >
                    {item.title}
                  </span>
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground/60 hover:text-primary shrink-0"
                    >
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>

                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 mt-0.5">
                  {item.ref && <span className="font-mono">{item.ref}</span>}
                  {item.labels && item.labels.length > 0 && (
                    <span className="text-muted-foreground/50">• {item.labels.join(', ')}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Right: Assigned Agent Badge & Quick Dispatch */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Assigned Agent Selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1.5 h-7 px-2 text-[11px] rounded-md border transition-colors ${
                      item.assignedAgent
                        ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                        : 'border-dashed border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Bot className="size-3.5" />
                    {item.assignedAgent ? (
                      <span className="flex items-center gap-1.5">
                        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                        {item.assignedAgent.label}
                      </span>
                    ) : (
                      <span>未指派</span>
                    )}
                    <ChevronDown className="size-3 opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase">
                    指派執行 Agent (PTY)
                  </div>
                  {activeAgents.map((agent) => (
                    <DropdownMenuItem
                      key={agent.index}
                      onSelect={() => onAssignAgent(item.id, agent)}
                    >
                      <Bot className="size-3.5 text-primary" />
                      <span>{agent.label}</span>
                    </DropdownMenuItem>
                  ))}
                  {item.assignedAgent && (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => onAssignAgent(item.id, undefined)}
                    >
                      清除指派
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Quick Dispatch Button */}
              {item.assignedAgent && !isCompleted && (
                <button
                  type="button"
                  onClick={() => onDispatch(item, item.assignedAgent!.index)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                  title={`一鍵派發至 ${item.assignedAgent.label} PTY`}
                >
                  <Send className="size-3.5" />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
