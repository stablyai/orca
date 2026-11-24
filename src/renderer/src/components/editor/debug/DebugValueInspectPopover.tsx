import { useEffect } from 'react'
import { Eye, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../../ui/popover'
import { DebugVariableTreeRows } from './DebugVariableTree'
import { useTranslate } from '@/i18n/use-translate'
import { useDebugSessionStore, type DebugVariable } from '@/store/debug/use-debug-session-store'

export function DebugValueInspectPopover({
  expression,
  variable,
  x,
  y,
  onClose
}: {
  expression: string
  variable: DebugVariable
  x: number
  y: number
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const expandVariables = useDebugSessionStore((s) => s.expandVariables)
  const addWatch = useDebugSessionStore((s) => s.addWatch)
  const children = useDebugSessionStore((s) =>
    variable.variablesReference > 0 ? s.variablesByRef[variable.variablesReference] : undefined
  )

  useEffect(() => {
    if (variable.variablesReference > 0) {
      void expandVariables(variable.variablesReference)
    }
  }, [expandVariables, variable.variablesReference])

  const watchExpr = variable.evaluateName ?? expression

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden="true"
          style={{ left: x, top: y }}
          className="pointer-events-none fixed size-px"
        />
      </PopoverAnchor>
      <PopoverContent align="start" sideOffset={6} className="w-96">
        <div className="flex flex-col text-xs">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono font-medium text-workflow-progress">
                {expression}
              </span>
              {variable.typeName ? (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {variable.typeName}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {watchExpr ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title={t('auto.components.editor.debug.addWatchTitle', 'Add to Watches')}
                  onClick={() => void addWatch(watchExpr)}
                >
                  <Eye className="size-3" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                title={t('auto.components.editor.debug.closeAction', 'Close')}
                onClick={onClose}
              >
                <X className="size-3" />
              </Button>
            </div>
          </div>

          {variable.variablesReference > 0 ? (
            <div className="max-h-64 overflow-y-auto scrollbar-sleek py-1">
              {children ? (
                <DebugVariableTreeRows
                  variables={children}
                  containerRef={variable.variablesReference}
                />
              ) : (
                <pre className="px-3 py-1 font-mono text-[11px] whitespace-pre-wrap break-all text-foreground">
                  {variable.value}
                </pre>
              )}
            </div>
          ) : (
            <pre className="max-h-64 select-text overflow-y-auto scrollbar-sleek px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-foreground">
              {variable.value}
            </pre>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
