import React, { useEffect, useMemo, useState } from 'react'
import {
  ListTodo,
  X,
  RefreshCw,
  Plus,
  Search,
  CheckCircle2,
  GitPullRequest,
  CircleDot,
  GitBranch,
  Kanban,
  ListCheck
} from 'lucide-react'
import { useBacklogStore } from '../../store/backlog-store'
import { useBacklogSync } from './use-backlog-sync'
import { BacklogChecklistView } from './BacklogChecklistView'
import { BacklogKanbanView } from './BacklogKanbanView'
import { Button } from '@/components/ui/button'
import type { BacklogCategoryFilter } from '../../../../shared/backlog-types'

export function BacklogAgentDialog(): React.JSX.Element | null {
  const isBacklogOpen = useBacklogStore((s) => s.isBacklogOpen)
  const setBacklogOpen = useBacklogStore((s) => s.setBacklogOpen)
  const viewMode = useBacklogStore((s) => s.viewMode)
  const setViewMode = useBacklogStore((s) => s.setViewMode)
  const categoryFilter = useBacklogStore((s) => s.categoryFilter)
  const setCategoryFilter = useBacklogStore((s) => s.setCategoryFilter)
  const searchQuery = useBacklogStore((s) => s.searchQuery)
  const setSearchQuery = useBacklogStore((s) => s.setSearchQuery)
  const toggleItemStatus = useBacklogStore((s) => s.toggleItemStatus)
  const assignAgentToItem = useBacklogStore((s) => s.assignAgentToItem)
  const addCustomItem = useBacklogStore((s) => s.addCustomItem)

  const { sessionInfo, activeAgents, items, loading, refresh, dispatchTaskToAgent } =
    useBacklogSync()

  const [newTaskTitle, setNewTaskTitle] = useState('')

  // Close with Escape key
  useEffect(() => {
    if (!isBacklogOpen) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBacklogOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isBacklogOpen, setBacklogOpen])

  // Filtered items
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (categoryFilter !== 'all' && item.kind !== categoryFilter) {
        return false
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchTitle = item.title.toLowerCase().includes(q)
        const matchRef = item.ref?.toLowerCase().includes(q)
        const matchAgent = item.assignedAgent?.label.toLowerCase().includes(q)
        if (!matchTitle && !matchRef && !matchAgent) {
          return false
        }
      }
      return true
    })
  }, [items, categoryFilter, searchQuery])

  // Progress metrics
  const { total, completed, inProgress, percent } = useMemo(() => {
    const total = items.length
    const completed = items.filter((i) => i.status === 'completed').length
    const inProgress = items.filter((i) => i.status === 'in_progress').length
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0
    return { total, completed, inProgress, percent }
  }, [items])

  if (!isBacklogOpen) {
    return null
  }

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTaskTitle.trim()) {
      return
    }
    addCustomItem(newTaskTitle)
    setNewTaskTitle('')
  }

  const categoryOptions: { id: BacklogCategoryFilter; label: string; icon: React.ReactNode }[] = [
    { id: 'all', label: '全部', icon: <ListTodo className="size-3.5" /> },
    { id: 'pr', label: 'PRs', icon: <GitPullRequest className="size-3.5 text-primary" /> },
    {
      id: 'issue',
      label: 'Issues',
      icon: <CircleDot className="size-3.5 text-muted-foreground" />
    },
    { id: 'branch', label: '分支', icon: <GitBranch className="size-3.5 text-primary" /> }
  ]

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 sm:p-6 animate-in fade-in duration-200"
      data-testid="backlog-agent-modal"
    >
      <div className="absolute inset-0" onClick={() => setBacklogOpen(false)} aria-hidden="true" />

      <div
        className="relative w-full max-w-5xl rounded-2xl border border-border/80 bg-background/95 p-6 shadow-2xl backdrop-blur-xl flex flex-col gap-4 max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-border/60">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center text-primary shadow-sm">
              <ListTodo className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-foreground tracking-tight">Backlog Agent</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-mono">
                  {sessionInfo.repoName} • {sessionInfo.branch}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                同步當前工作階段 GitHub PR / Issue / Branch，掌握多 Agent 分工與進度
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center bg-muted/30 border border-border/70 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setViewMode('checklist')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-all ${
                  viewMode === 'checklist'
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <ListCheck className="size-3.5" />
                <span>核選清單</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('kanban')}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-all ${
                  viewMode === 'kanban'
                    ? 'bg-primary text-primary-foreground font-medium shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Kanban className="size-3.5" />
                <span>看板</span>
              </button>
            </div>

            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>同步</span>
            </Button>

            <button
              type="button"
              onClick={() => setBacklogOpen(false)}
              className="size-8 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Progress Bar & Quick Stats */}
        <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-card/40 border border-border/50">
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-primary" />
              <span className="font-semibold text-foreground">{percent}% 完成</span>
              <span className="text-muted-foreground font-mono">
                ({completed}/{total})
              </span>
            </div>
            <span className="text-muted-foreground/40">|</span>
            <div className="flex items-center gap-1.5 text-primary">
              <span className="size-2 rounded-full bg-primary animate-pulse" />
              <span>{inProgress} 進行中</span>
            </div>
            <div className="text-muted-foreground">
              <span>
                {activeAgents.length} 支活躍 Agent (
                {activeAgents.map((a) => `@${a.index}`).join(', ')})
              </span>
            </div>
          </div>

          <div className="w-48 h-2 rounded-full bg-muted/60 overflow-hidden border border-border/40">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        {/* Search, Filter & Quick Add Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Category Filters */}
          <div className="flex items-center gap-1.5">
            {categoryOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCategoryFilter(opt.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  categoryFilter === opt.id
                    ? 'bg-primary/15 border-primary/40 text-primary'
                    : 'bg-card/40 border-border/60 text-muted-foreground hover:text-foreground hover:bg-card/70'
                }`}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </button>
            ))}
          </div>

          {/* Search + Add */}
          <div className="flex items-center gap-2">
            <div className="relative w-48">
              <Search className="size-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋任務、Agent..."
                className="h-8 w-full rounded-md border border-border bg-input/40 pl-8 pr-2 text-xs placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <form onSubmit={handleAddTask} className="flex items-center gap-1.5">
              <input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="新增待辦任務..."
                className="h-8 w-44 rounded-md border border-border bg-input/40 px-3 text-xs placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              />
              <Button type="submit" size="sm">
                <Plus className="size-3.5" />
                <span>新增</span>
              </Button>
            </form>
          </div>
        </div>

        {/* Main View Area */}
        <div className="flex-1 min-h-0">
          {viewMode === 'checklist' ? (
            <BacklogChecklistView
              items={filteredItems}
              activeAgents={activeAgents}
              onToggleStatus={toggleItemStatus}
              onAssignAgent={assignAgentToItem}
              onDispatch={dispatchTaskToAgent}
            />
          ) : (
            <BacklogKanbanView
              items={filteredItems}
              activeAgents={activeAgents}
              onToggleStatus={toggleItemStatus}
              onAssignAgent={assignAgentToItem}
              onDispatch={dispatchTaskToAgent}
            />
          )}
        </div>
      </div>
    </div>
  )
}
