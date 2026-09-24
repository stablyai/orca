import React from 'react'
import { CheckCircle2, Clock, ListOrdered, Bot, Send } from 'lucide-react'
import type { AssignedAgentInfo, BacklogItem } from '../../../../shared/backlog-types'

type BacklogKanbanViewProps = {
  items: BacklogItem[]
  activeAgents: AssignedAgentInfo[]
  onToggleStatus: (id: string) => void
  onAssignAgent: (id: string, agent: AssignedAgentInfo | undefined) => void
  onDispatch: (item: BacklogItem, agentIndex: number) => void
}

export function BacklogKanbanView({
  items,
  onToggleStatus,
  onDispatch
}: BacklogKanbanViewProps): React.JSX.Element {
  const todoItems = items.filter((i) => i.status === 'todo')
  const inProgressItems = items.filter((i) => i.status === 'in_progress')
  const completedItems = items.filter((i) => i.status === 'completed')

  const columns = [
    {
      id: 'todo',
      title: '待辦清單 (Todo)',
      icon: <ListOrdered className="size-4 text-muted-foreground" />,
      items: todoItems,
      borderColor: 'border-border/60',
      badgeColor: 'bg-muted/40 text-muted-foreground'
    },
    {
      id: 'in_progress',
      title: '進行中 (In Progress)',
      icon: <Clock className="size-4 text-primary" />,
      items: inProgressItems,
      borderColor: 'border-primary/30',
      badgeColor: 'bg-primary/10 text-primary'
    },
    {
      id: 'completed',
      title: '已完成 (Completed)',
      icon: <CheckCircle2 className="size-4 text-primary" />,
      items: completedItems,
      borderColor: 'border-border',
      badgeColor: 'bg-accent text-accent-foreground'
    }
  ]

  return (
    <div className="grid grid-cols-3 gap-3 h-[58vh] max-h-[58vh]">
      {columns.map((col) => (
        <div
          key={col.id}
          className={`flex flex-col rounded-xl border ${col.borderColor} bg-card/20 p-2.5 min-h-0`}
        >
          {/* Column Header */}
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/40">
            <div className="flex items-center gap-2 text-xs font-semibold">
              {col.icon}
              <span>{col.title}</span>
            </div>
            <span className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${col.badgeColor}`}>
              {col.items.length}
            </span>
          </div>

          {/* Cards */}
          <div className="flex-1 overflow-y-auto space-y-2 scrollbar-sleek pr-1">
            {col.items.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-xs text-muted-foreground/50 italic">
                無項目
              </div>
            ) : (
              col.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-border/70 bg-card/60 p-2.5 shadow-sm hover:border-primary/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium line-clamp-2">{item.title}</span>
                    <button
                      type="button"
                      onClick={() => onToggleStatus(item.id)}
                      className="h-5 px-1.5 text-[10px] rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 shrink-0 transition-colors"
                    >
                      {item.status === 'completed' ? '重新開啟' : '標記完成'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/40 text-[11px]">
                    <span className="text-muted-foreground/70 font-mono text-[10px]">
                      {item.ref || item.kind.toUpperCase()}
                    </span>

                    {item.assignedAgent ? (
                      <div className="flex items-center gap-1.5 text-primary font-medium">
                        <Bot className="size-3" />
                        <span>{item.assignedAgent.label}</span>
                        {item.status !== 'completed' && (
                          <button
                            type="button"
                            onClick={() => onDispatch(item, item.assignedAgent!.index)}
                            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                            title="派工"
                          >
                            <Send className="size-2.5" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50 text-[10px]">未指派</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
