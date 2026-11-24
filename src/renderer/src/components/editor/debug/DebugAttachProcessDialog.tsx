import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { invokeNative, isTauriNativeHost } from '@/web/tauri-native-host'
import {
  buildAttachLaunchConfig,
  buildAttachRows,
  formatAttachDetail,
  type DebugAttachableProcess
} from '@/store/debug/debug-attach-processes'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

function AttachProcessBody({
  workspaceRoot,
  onClose
}: {
  workspaceRoot?: string | null
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const startSession = useDebugSessionStore((s) => s.startSession)
  const [filter, setFilter] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [processes, setProcesses] = useState<DebugAttachableProcess[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshSeq, setRefreshSeq] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!isTauriNativeHost()) {
      return () => {
        cancelled = true
      }
    }
    void invokeNative<DebugAttachableProcess[]>('poc_debug_attachable_processes')
      .then((list) => {
        if (!cancelled) {
          setProcesses(list)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setProcesses([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshSeq])

  const rows = useMemo(() => buildAttachRows(processes ?? [], filter), [processes, filter])
  const firstItemIndex = rows.findIndex((row) => row.kind === 'process')
  const selectedIndex = rows[activeIndex]?.kind === 'process' ? activeIndex : firstItemIndex

  const attachToProcess = (proc: DebugAttachableProcess): void => {
    onClose()
    void startSession(buildAttachLaunchConfig(proc, workspaceRoot))
  }

  const moveSelection = (delta: 1 | -1): void => {
    for (let i = selectedIndex + delta; i >= 0 && i < rows.length; i += delta) {
      if (rows[i]?.kind === 'process') {
        setActiveIndex(i)
        return
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeOwnedKeyboardEvent(e)) {
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(e.key === 'ArrowDown' ? 1 : -1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const current = rows[selectedIndex]
      if (current?.kind === 'process') {
        attachToProcess(current.process)
      }
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <input
          type="text"
          autoFocus
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value)
            setActiveIndex(0)
          }}
          onKeyDown={handleKeyDown}
          placeholder={t(
            'auto.components.editor.debug.filterProcessesPlaceholder',
            'Filter by PID, name, or command line...'
          )}
          className="h-8 min-w-0 flex-1 rounded border border-border/70 bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          title={t('auto.components.editor.debug.refreshTitle', 'Refresh')}
          onClick={() => {
            setProcesses(null)
            setError(null)
            setRefreshSeq((n) => n + 1)
          }}
        >
          <RefreshCw className="size-3" />
          {t('auto.components.editor.debug.refreshTitle', 'Refresh')}
        </Button>
      </div>

      <div className="max-h-80 overflow-y-auto scrollbar-sleek rounded border border-border/70 bg-background/60 p-1">
        {!isTauriNativeHost() ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('auto.components.editor.debug.emptyProcesses', 'No attachable processes found.')}
          </div>
        ) : processes === null ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('auto.components.editor.debug.loadingProcesses', 'Scanning processes...')}
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-xs text-destructive">{error}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {filter.trim()
              ? t('auto.components.editor.debug.noMatchingProcesses', 'No matching processes.')
              : t('auto.components.editor.debug.emptyProcesses', 'No attachable processes found.')}
          </div>
        ) : (
          rows.map((row, idx) =>
            row.kind === 'group' ? (
              <div
                key={row.key}
                className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {row.label} ({row.count})
              </div>
            ) : (
              <button
                key={row.key}
                type="button"
                title={row.process.commandLine}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => attachToProcess(row.process)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11px]',
                  idx === selectedIndex
                    ? 'bg-primary/15 text-foreground'
                    : 'text-foreground/90 hover:bg-accent/60'
                )}
              >
                <span className="w-14 shrink-0 text-muted-foreground">{row.process.pid}</span>
                <span className="w-28 shrink-0 truncate font-medium">{row.process.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {row.process.commandLine}
                </span>
                <span className="shrink-0 text-[10px] text-workflow-progress">
                  {formatAttachDetail(row.process)}
                </span>
              </button>
            )
          )
        )}
      </div>
    </div>
  )
}

export function DebugAttachProcessDialog({
  open,
  onOpenChange,
  workspaceRoot
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceRoot?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.editor.debug.attachProcessTitle', 'Attach to Process')}
          </DialogTitle>
        </DialogHeader>
        {open ? (
          <AttachProcessBody workspaceRoot={workspaceRoot} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
