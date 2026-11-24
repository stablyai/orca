import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import { DebugVariableTreeRows } from './DebugVariableTree'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useDebugSessionStore } from '@/store/debug/use-debug-session-store'

export function DebugSessionPanel({
  layout = 'horizontal'
}: {
  layout?: 'horizontal' | 'vertical'
} = {}): React.JSX.Element {
  const [evalDraft, setEvalDraft] = useState('')
  const [watchDraft, setWatchDraft] = useState('')
  const t = useTranslate()

  const activeSessionId = useDebugSessionStore((s) => s.activeSessionId)
  const status = useDebugSessionStore((s) => s.status)
  const threads = useDebugSessionStore((s) => s.threads)
  const activeThreadId = useDebugSessionStore((s) => s.activeThreadId)
  const frames = useDebugSessionStore((s) => s.frames)
  const scopes = useDebugSessionStore((s) => s.scopes)
  const variablesByRef = useDebugSessionStore((s) => s.variablesByRef)
  const activeFrameId = useDebugSessionStore((s) => s.activeFrameId)
  const watches = useDebugSessionStore((s) => s.watches)
  const exceptionFilters = useDebugSessionStore((s) => s.exceptionFilters)
  const exceptionFilterChoices = useDebugSessionStore((s) => s.exceptionFilterChoices)
  const supportsProgramInput = useDebugSessionStore((s) => s.supportsProgramInput)
  const consoleLines = useDebugSessionStore((s) => s.consoleLines)

  const selectThread = useDebugSessionStore((s) => s.selectThread)
  const selectFrame = useDebugSessionStore((s) => s.selectFrame)
  const evaluateExpression = useDebugSessionStore((s) => s.evaluateExpression)
  const toggleExceptionFilter = useDebugSessionStore((s) => s.toggleExceptionFilter)
  const addWatch = useDebugSessionStore((s) => s.addWatch)
  const removeWatch = useDebugSessionStore((s) => s.removeWatch)
  const clearConsole = useDebugSessionStore((s) => s.clearConsole)

  const activeExceptionFilters =
    exceptionFilters.find((s) => s.session === activeSessionId)?.filters ??
    exceptionFilters[0]?.filters ??
    []

  const isVertical = layout === 'vertical'

  return (
    <div
      className={cn(
        'bg-background/90 text-xs',
        isVertical
          ? 'flex flex-col divide-y divide-border'
          : 'grid h-52 grid-cols-3 divide-x divide-border border-t border-border'
      )}
    >
      <div className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('auto.components.editor.debug.callStackTitle', 'Call Stack')}
          </span>
          {threads.length > 1 ? (
            <select
              aria-label={t('auto.components.editor.debug.threadSelect', 'Thread')}
              value={activeThreadId ?? ''}
              onChange={(e) => void selectThread(Number(e.target.value))}
              className="h-5 max-w-32 rounded border border-border/70 bg-background px-1 text-[10px] text-foreground outline-none"
            >
              {threads.map((th) => (
                <option key={th.id} value={th.id}>
                  {th.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className={cn('flex-1 overflow-y-auto scrollbar-sleek p-1', isVertical && 'max-h-36')}>
          {frames.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              {status === 'stopped'
                ? t('auto.components.editor.debug.noFrames', 'No frames')
                : t('auto.components.editor.debug.notPaused', 'Not paused')}
            </div>
          ) : (
            frames.map((frame) => (
              <button
                key={frame.id}
                type="button"
                onClick={() => void selectFrame(frame.id, true)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left font-mono text-[11px]',
                  frame.id === activeFrameId
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  frame.presentationHint === 'subtle' ? 'opacity-65' : ''
                )}
              >
                <span className="truncate">{frame.name}</span>
                <span className="shrink-0 text-[10px] opacity-70">:{frame.line}</span>
              </button>
            ))
          )}
        </div>
        {activeExceptionFilters.length > 0 ? (
          <div className="flex flex-wrap gap-1 border-t border-border/60 px-2 py-1">
            {activeExceptionFilters.map((f) => {
              const active = exceptionFilterChoices[f.filter] ?? f.default
              return (
                <label
                  key={f.filter}
                  title={f.description ?? f.label}
                  className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => void toggleExceptionFilter(f.filter)}
                    className="size-3"
                  />
                  <span>{f.label}</span>
                </label>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-col">
        <div className="border-b border-border/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          {t('auto.components.editor.debug.variablesTitle', 'Variables')}
        </div>
        <div
          className={cn('flex-1 overflow-y-auto scrollbar-sleek py-1', isVertical && 'max-h-48')}
        >
          {watches.length > 0 ? (
            <div className="mb-1.5 border-b border-border/40 pb-1">
              <div className="px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t('auto.components.editor.debug.watchesTitle', 'Watches')}
              </div>
              {watches.map((w) => (
                <div
                  key={w.id}
                  className="flex items-center gap-1.5 px-2.5 py-0.5 font-mono text-[11px] hover:bg-accent/50"
                >
                  <span className="text-workflow-progress">{w.expression}:</span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      w.error ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {w.error ?? w.value ?? '...'}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeWatch(w.id)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {scopes.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
              {t('auto.components.editor.debug.noScopes', 'No scopes')}
            </div>
          ) : (
            scopes.map((scope) => {
              const vars = variablesByRef[scope.variablesReference] ?? []
              return (
                <div key={scope.variablesReference} className="mb-1">
                  <div className="px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {scope.name}
                  </div>
                  <DebugVariableTreeRows variables={vars} containerRef={scope.variablesReference} />
                </div>
              )
            })
          )}
        </div>
        <div className="flex items-center gap-1 border-t border-border/60 p-1">
          <input
            type="text"
            value={watchDraft}
            onChange={(e) => setWatchDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isImeOwnedKeyboardEvent(e)) {
                return
              }
              if (e.key === 'Enter' && watchDraft.trim()) {
                e.preventDefault()
                const expr = watchDraft
                setWatchDraft('')
                void addWatch(expr)
              }
            }}
            placeholder={t(
              'auto.components.editor.debug.addWatchPlaceholder',
              'Add watch expression...'
            )}
            className="min-w-0 flex-1 rounded border border-border/70 bg-background px-2 py-0.5 font-mono text-[11px] text-foreground outline-none focus:border-primary"
          />
          <button
            type="button"
            title={t('auto.components.editor.debug.addWatchTitle', 'Add to Watches')}
            onClick={() => {
              if (!watchDraft.trim()) {
                return
              }
              const expr = watchDraft
              setWatchDraft('')
              void addWatch(expr)
            }}
            className="rounded border border-border/70 p-1 text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('auto.components.editor.debug.consoleTitle', 'Console / Eval')}
          </span>
          <button
            type="button"
            title={t('auto.components.editor.debug.clearConsoleTitle', 'Clear Console')}
            onClick={clearConsole}
            className="text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
        <div
          className={cn(
            'flex-1 overflow-y-auto scrollbar-sleek p-2 font-mono text-[11px]',
            isVertical && 'max-h-36'
          )}
        >
          {consoleLines.map((line) => (
            <pre
              key={line.id}
              className={cn(
                'whitespace-pre-wrap break-all',
                line.category === 'stderr'
                  ? 'text-destructive'
                  : line.category === 'input'
                    ? 'text-workflow-progress'
                    : line.category === 'system'
                      ? 'text-muted-foreground'
                      : 'text-foreground'
              )}
            >
              {line.text}
            </pre>
          ))}
        </div>
        <div className="border-t border-border/60 p-1.5">
          <input
            type="text"
            value={evalDraft}
            onChange={(e) => setEvalDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isImeOwnedKeyboardEvent(e)) {
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                const expr = evalDraft
                setEvalDraft('')
                void evaluateExpression(expr)
              }
            }}
            placeholder={
              supportsProgramInput && status === 'running'
                ? t('auto.components.editor.debug.stdinPlaceholder', 'Send stdin to program...')
                : t(
                    'auto.components.editor.debug.evalPlaceholder',
                    'Evaluate expression (Enter)...'
                  )
            }
            className="w-full rounded border border-border/70 bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-primary"
          />
        </div>
      </div>
    </div>
  )
}
