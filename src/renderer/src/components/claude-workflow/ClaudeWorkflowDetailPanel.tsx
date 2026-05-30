import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Copy, ExternalLink, FileCode2, Loader2 } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import type { ClaudeWorkflowDetail } from '../../../../shared/claude-workflow-detail'

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) {
    return 'unknown'
  }
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
}

function formatTime(value: number | undefined): string {
  return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

function CopyButton({ value, label }: { value: string | undefined; label: string }) {
  if (!value) {
    return null
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={() => void window.api.ui.writeClipboardText(value)}
    >
      <Copy className="size-3" />
    </Button>
  )
}

function WarningList({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) {
    return null
  }
  return (
    <div className="space-y-1 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
      {warnings.map((warning) => (
        <div key={warning} className="flex min-w-0 items-start gap-2">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 break-words">{warning}</span>
        </div>
      ))}
    </div>
  )
}

function TimelineTab({ detail }: { detail: ClaudeWorkflowDetail }) {
  return (
    <div className="space-y-3 p-4">
      {detail.timeline.map((item) => (
        <div key={item.id} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 text-xs">
          <div className="text-muted-foreground tabular-nums">{formatTime(item.startedAt)}</div>
          <div className="min-w-0 border-l border-border pl-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium text-foreground">
                {item.state ? agentStateLabel(item.state as AgentDotState) : 'Event'}
              </span>
              <span className="min-w-0 truncate text-muted-foreground" title={item.label}>
                {item.label}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {formatDuration(item.durationMs)}
            </div>
          </div>
        </div>
      ))}
      {detail.timeline.length === 0 && (
        <p className="text-sm text-muted-foreground">No timeline events were available.</p>
      )}
    </div>
  )
}

function AgentsTab({ detail }: { detail: ClaudeWorkflowDetail }) {
  return (
    <div className="divide-y divide-border/60">
      {detail.agents.map((agent) => (
        <div key={agent.id} className="grid gap-1 px-4 py-3 text-xs">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="min-w-0 truncate font-medium text-foreground" title={agent.label}>
              {agent.label}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{agent.state}</span>
          </div>
          {agent.prompt && (
            <p className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words text-muted-foreground">
              {agent.prompt}
            </p>
          )}
          {agent.lastMessage && (
            <p className="line-clamp-2 min-w-0 break-words text-muted-foreground/80">
              {agent.lastMessage}
            </p>
          )}
        </div>
      ))}
      {detail.agents.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">
          No subagent transcript preview was available.
        </p>
      )}
    </div>
  )
}

function ScriptTab({ detail }: { detail: ClaudeWorkflowDetail }) {
  const script = detail.scriptPreview
  const isLocal = detail.target.connectionId === null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-4 py-2 text-xs">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
          title={script?.path}
        >
          {script?.path ?? 'No generated script path was discovered.'}
        </span>
        <CopyButton value={script?.path} label="Copy script path" />
        <CopyButton value={script?.content} label="Copy script preview" />
        {isLocal && script?.path && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Open script"
            title="Open script"
            onClick={() => void window.api.shell.openPath(script.path!)}
          >
            <ExternalLink className="size-3" />
          </Button>
        )}
      </div>
      <pre
        className={cn(
          'min-h-0 flex-1 overflow-auto scrollbar-sleek p-4 font-mono text-xs leading-relaxed',
          'whitespace-pre-wrap break-words text-muted-foreground'
        )}
      >
        {script?.binary
          ? 'Script preview looked binary and was hidden.'
          : script?.content || 'No script preview available.'}
      </pre>
    </div>
  )
}

export default function ClaudeWorkflowDetailPanel(): React.JSX.Element {
  const target = useAppStore((s) => s.selectedClaudeWorkflowTarget)
  const status = useAppStore((s) => s.claudeWorkflowDetailStatus)
  const liveEntry = useAppStore((s) =>
    target ? s.agentStatusByPaneKey[target.paneKey] : undefined
  )
  const retainedEntry = useAppStore((s) =>
    target ? s.retainedAgentsByPaneKey[target.paneKey] : undefined
  )
  const close = useAppStore((s) => s.closeClaudeWorkflowDetail)
  const load = useAppStore((s) => s.loadClaudeWorkflowDetail)
  const [tab, setTab] = useState('timeline')

  useEffect(() => {
    if (target) {
      void load()
    }
  }, [target, load])

  useEffect(() => {
    if (target && !liveEntry && !retainedEntry) {
      close()
    }
  }, [close, liveEntry, retainedEntry, target])

  const headerMeta = useMemo(() => {
    const detail = status.detail
    const elapsed = detail?.metrics?.elapsedMs
    return [
      target?.state ? agentStateLabel(target.state as AgentDotState) : null,
      elapsed ? formatDuration(elapsed) : null,
      target?.terminalTitle ?? target?.tabTitle ?? null
    ].filter(Boolean)
  }, [status.detail, target])

  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-[min(92vw,720px)] sm:max-w-[720px]">
        <SheetHeader className="border-b border-border/60 pr-12">
          <SheetTitle className="truncate text-sm">
            {target?.prompt?.trim() || 'Claude workflow'}
          </SheetTitle>
          <SheetDescription className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs">
            {headerMeta.map((part) => (
              <span key={part} className="min-w-0 truncate">
                {part}
              </span>
            ))}
          </SheetDescription>
        </SheetHeader>
        <WarningList warnings={status.detail?.warnings ?? []} />
        {status.loading && !status.detail ? (
          <div className="flex flex-1 items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading workflow detail…
          </div>
        ) : status.error ? (
          <div className="p-4 text-sm text-muted-foreground">{status.error}</div>
        ) : status.detail ? (
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
            <div className="border-b border-border/60 px-4 py-2">
              <TabsList className="h-8">
                <TabsTrigger value="timeline" className="text-xs">
                  Timeline
                </TabsTrigger>
                <TabsTrigger value="agents" className="text-xs">
                  Agents
                </TabsTrigger>
                <TabsTrigger value="script" className="text-xs">
                  Script
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="timeline" className="min-h-0 overflow-auto scrollbar-sleek">
              <TimelineTab detail={status.detail} />
            </TabsContent>
            <TabsContent value="agents" className="min-h-0 overflow-auto scrollbar-sleek">
              <AgentsTab detail={status.detail} />
            </TabsContent>
            <TabsContent value="script" className="min-h-0 overflow-hidden">
              <ScriptTab detail={status.detail} />
            </TabsContent>
          </Tabs>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
