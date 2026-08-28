import { useCallback, useEffect, useState } from 'react'
import type React from 'react'
import { Check, Copy, LoaderCircle, MoreHorizontal, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ExternalTaskDetailView } from '@/components/task-page/external-task-detail-view'
import type { ExternalTask, ExternalTaskProvider } from '../../../../shared/external-task-types'

const labels: Record<ExternalTaskProvider, string> = {
  'azure-devops': 'Azure DevOps work items',
  planner: 'Microsoft Planner tasks',
  ninjaone: 'NinjaOne tickets'
}

export function ExternalTaskList({
  provider,
  onUseTask
}: {
  provider: ExternalTaskProvider
  onUseTask: (task: ExternalTask) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [tasks, setTasks] = useState<ExternalTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<ExternalTask | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.api.externalTasks.status(provider)
      if (!status.authenticated) {
        setTasks([])
        setError(status.error ?? `Configure ${labels[provider]} in Settings → Integrations.`)
        return
      }
      const result = await window.api.externalTasks.list({ provider, query, limit: 100 })
      setTasks(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load work items.')
    } finally {
      setLoading(false)
    }
  }, [provider, query])

  useEffect(() => {
    void load()
  }, [load])

  if (selectedTask) {
    return (
      <ExternalTaskDetailView
        provider={provider}
        task={selectedTask}
        onBack={() => setSelectedTask(null)}
        onUseTask={onUseTask}
        onUpdated={(updated) => {
          setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)))
          setSelectedTask(updated)
        }}
      />
    )
  }

  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/50 bg-card p-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${labels[provider].toLowerCase()}`}
          className="max-w-md"
        />
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : undefined} /> Refresh
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          {tasks.length} {tasks.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-14">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="px-6 py-14 text-center text-sm text-muted-foreground">{error}</div>
      ) : tasks.length === 0 ? (
        <div className="px-6 py-14 text-center text-sm text-muted-foreground">
          No work items found.
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
          {tasks.map((task) => (
            <div
              key={`${task.provider}:${task.id}`}
              className="group flex items-center gap-3 border-b border-border/40 bg-background px-4 py-3 transition-colors hover:bg-accent/50 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{task.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{task.identifier}</span>
                  {task.assignee ? ` · ${task.assignee}` : ''}
                </div>
              </div>
              <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
                {task.status}
              </Badge>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setSelectedTask(task)}>
                  View / edit
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${task.identifier}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onUseTask(task)}>
                      Create coding workspace
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void window.api.shell.openUrl(task.url)}>
                      Open in system browser
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        void navigator.clipboard.writeText(task.url)
                        setCopiedId(task.id)
                        window.setTimeout(() => setCopiedId((current) => (current === task.id ? null : current)), 1500)
                      }}
                    >
                      {copiedId === task.id ? <Check /> : <Copy />}
                      {copiedId === task.id ? 'Copied link' : 'Copy link'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
