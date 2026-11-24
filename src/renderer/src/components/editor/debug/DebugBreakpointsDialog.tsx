import { useMemo, useState } from 'react'
import { Ban, Plus, Trash2 } from 'lucide-react'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog'
import {
  FunctionBreakpointDetailEditor,
  LineBreakpointDetailEditor
} from './DebugBreakpointsDetail'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

type SelectionKey = { kind: 'line'; fileKey: string; line: number } | { kind: 'fn'; index: number }

export function DebugBreakpointsDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const breakpointsByFile = useDebugSessionStore((s) => s.breakpointsByFile)
  const breakpointPathsByKey = useDebugSessionStore((s) => s.breakpointPathsByKey)
  const breakpointsMuted = useDebugSessionStore((s) => s.breakpointsMuted)
  const functionBreakpoints = useDebugSessionStore((s) => s.functionBreakpoints)
  const exceptionFilters = useDebugSessionStore((s) => s.exceptionFilters)
  const exceptionFilterChoices = useDebugSessionStore((s) => s.exceptionFilterChoices)
  const activeSessionId = useDebugSessionStore((s) => s.activeSessionId)

  const setBreakpointsMuted = useDebugSessionStore((s) => s.setBreakpointsMuted)
  const updateBreakpoint = useDebugSessionStore((s) => s.updateBreakpoint)
  const addFunctionBreakpoint = useDebugSessionStore((s) => s.addFunctionBreakpoint)
  const updateFunctionBreakpoint = useDebugSessionStore((s) => s.updateFunctionBreakpoint)
  const removeAllBreakpoints = useDebugSessionStore((s) => s.removeAllBreakpoints)
  const toggleExceptionFilter = useDebugSessionStore((s) => s.toggleExceptionFilter)

  const [selected, setSelected] = useState<SelectionKey | null>(null)
  const [fnDraft, setFnDraft] = useState('')

  const lineRows = useMemo(
    () =>
      Object.entries(breakpointsByFile)
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([fileKey, bps]) => {
          const filePath = breakpointPathsByKey[fileKey] ?? fileKey
          const fileName = filePath.split(/[\\/]/).at(-1) || filePath
          return bps.map((bp) => ({ fileKey, filePath, fileName, bp }))
        }),
    [breakpointPathsByKey, breakpointsByFile]
  )

  const resolvedSelection: SelectionKey | null = useMemo(() => {
    if (selected?.kind === 'line') {
      const hit = lineRows.find(
        (r) => r.fileKey === selected.fileKey && r.bp.line === selected.line
      )
      if (hit) {
        return selected
      }
    } else if (selected?.kind === 'fn' && functionBreakpoints[selected.index]) {
      return selected
    }
    if (lineRows[0]) {
      return { kind: 'line', fileKey: lineRows[0].fileKey, line: lineRows[0].bp.line }
    }
    if (functionBreakpoints[0]) {
      return { kind: 'fn', index: 0 }
    }
    return null
  }, [functionBreakpoints, lineRows, selected])

  const selectedLine =
    resolvedSelection?.kind === 'line'
      ? lineRows.find(
          (r) => r.fileKey === resolvedSelection.fileKey && r.bp.line === resolvedSelection.line
        )
      : undefined
  const selectedFn =
    resolvedSelection?.kind === 'fn' ? functionBreakpoints[resolvedSelection.index] : undefined

  const activeFilters =
    exceptionFilters.find((item) => item.session === activeSessionId)?.filters ??
    exceptionFilters[0]?.filters ??
    []

  const handleAddFunction = (): void => {
    if (!fnDraft.trim()) {
      return
    }
    const nextIdx = functionBreakpoints.length
    const expr = fnDraft
    setFnDraft('')
    void addFunctionBreakpoint(expr)
    setSelected({ kind: 'fn', index: nextIdx })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.editor.debug.breakpointsTitle', 'Breakpoints')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid h-96 grid-cols-12 gap-3 text-xs">
          <div className="col-span-5 flex min-h-0 flex-col rounded border border-border/70 bg-background/60">
            <div className="flex items-center justify-between gap-1 border-b border-border/60 px-2 py-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-pressed={breakpointsMuted}
                onClick={() => void setBreakpointsMuted(!breakpointsMuted)}
              >
                <Ban
                  className={cn(
                    'size-3',
                    breakpointsMuted ? 'text-status-warning' : 'text-muted-foreground'
                  )}
                />
                {breakpointsMuted
                  ? t('auto.components.editor.debug.unmuteBreakpointsTitle', 'Unmute Breakpoints')
                  : t('auto.components.editor.debug.muteBreakpointsTitle', 'Mute Breakpoints')}
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={lineRows.length === 0 && functionBreakpoints.length === 0}
                title={t(
                  'auto.components.editor.debug.clearBreakpointsTitle',
                  'Remove All Breakpoints'
                )}
                onClick={() => void removeAllBreakpoints()}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>

            <div className="flex items-center gap-1 border-b border-border/60 p-1.5">
              <input
                type="text"
                value={fnDraft}
                onChange={(e) => setFnDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (!isImeOwnedKeyboardEvent(e) && e.key === 'Enter') {
                    e.preventDefault()
                    handleAddFunction()
                  }
                }}
                placeholder={t(
                  'auto.components.editor.debug.addFunctionBreakpointPlaceholder',
                  'Add function breakpoint (e.g. main)...'
                )}
                className="min-w-0 flex-1 rounded border border-border/70 bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary"
              />
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                title={t(
                  'auto.components.editor.debug.addFunctionBreakpointTitle',
                  'Add Function Breakpoint'
                )}
                onClick={handleAddFunction}
              >
                <Plus className="size-3" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-sleek p-1">
              {lineRows.length > 0 ? (
                <div className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('auto.components.editor.debug.lineBreakpointsTitle', 'Line Breakpoints')}
                  </div>
                  {lineRows.map((row) => {
                    const isSelected =
                      resolvedSelection?.kind === 'line' &&
                      resolvedSelection.fileKey === row.fileKey &&
                      resolvedSelection.line === row.bp.line
                    return (
                      <div
                        key={`${row.fileKey}:${row.bp.line}`}
                        onClick={() =>
                          setSelected({ kind: 'line', fileKey: row.fileKey, line: row.bp.line })
                        }
                        className={cn(
                          'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px]',
                          isSelected
                            ? 'bg-primary/15 text-foreground'
                            : 'text-foreground/90 hover:bg-accent/60'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={row.bp.enabled}
                          onChange={(e) => {
                            e.stopPropagation()
                            void updateBreakpoint(row.filePath, row.bp.line, {
                              enabled: e.target.checked
                            })
                          }}
                          className="size-3 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {row.fileName}:{row.bp.line}
                        </span>
                        {row.bp.logMessage?.trim() ? (
                          <span className="shrink-0 text-[10px] text-workflow-progress">
                            {t('auto.components.editor.debug.logBadge', 'log')}
                          </span>
                        ) : row.bp.condition?.trim() || row.bp.hitCondition?.trim() ? (
                          <span className="shrink-0 text-[10px] text-status-warning">
                            {t('auto.components.editor.debug.conditionBadge', 'if')}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {functionBreakpoints.length > 0 ? (
                <div className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(
                      'auto.components.editor.debug.functionBreakpointsTitle',
                      'Function Breakpoints'
                    )}
                  </div>
                  {functionBreakpoints.map((fnBp, idx) => {
                    const isSelected =
                      resolvedSelection?.kind === 'fn' && resolvedSelection.index === idx
                    return (
                      <div
                        key={fnBp.name}
                        onClick={() => setSelected({ kind: 'fn', index: idx })}
                        className={cn(
                          'flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 font-mono text-[11px]',
                          isSelected
                            ? 'bg-primary/15 text-foreground'
                            : 'text-foreground/90 hover:bg-accent/60'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={fnBp.enabled}
                          onChange={(e) => {
                            e.stopPropagation()
                            void updateFunctionBreakpoint(idx, { enabled: e.target.checked })
                          }}
                          className="size-3 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">{fnBp.name}</span>
                      </div>
                    )
                  })}
                </div>
              ) : null}

              {lineRows.length === 0 && functionBreakpoints.length === 0 ? (
                <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">
                  {t(
                    'auto.components.editor.debug.emptyBreakpoints',
                    'No breakpoints yet. Click an editor line number or add a function breakpoint.'
                  )}
                </div>
              ) : null}
            </div>

            {activeFilters.length > 0 ? (
              <div className="border-t border-border/60 px-2.5 py-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('auto.components.editor.debug.exceptionFiltersTitle', 'Exception Filters')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeFilters.map((f) => (
                    <label
                      key={f.filter}
                      title={f.description ?? f.label}
                      className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={exceptionFilterChoices[f.filter] ?? f.default}
                        onChange={() => void toggleExceptionFilter(f.filter)}
                        className="size-3"
                      />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="col-span-7 overflow-y-auto scrollbar-sleek rounded border border-border/70 bg-background/60 p-3">
            {selectedLine ? (
              <LineBreakpointDetailEditor
                key={`${selectedLine.fileKey}:${selectedLine.bp.line}`}
                filePath={selectedLine.filePath}
                bp={selectedLine.bp}
                onCloseDialog={() => onOpenChange(false)}
              />
            ) : selectedFn && resolvedSelection?.kind === 'fn' ? (
              <FunctionBreakpointDetailEditor
                key={`fn:${resolvedSelection.index}:${selectedFn.name}`}
                index={resolvedSelection.index}
                bp={selectedFn}
              />
            ) : (
              <div className="py-12 text-center text-xs text-muted-foreground">
                {t(
                  'auto.components.editor.debug.selectBreakpointHint',
                  'Select a breakpoint to view or edit properties.'
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
