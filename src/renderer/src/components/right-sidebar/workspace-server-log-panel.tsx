import React, { useEffect, useRef } from 'react'
import { Copy, X, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorkspaceServerSnapshot } from '../../../../shared/workspace-server-process'

export function WorkspaceServerLogPanel({
  name,
  run,
  onClose,
  visible = true,
  className
}: {
  name: string
  run?: WorkspaceServerSnapshot
  onClose: () => void
  visible?: boolean
  className?: string
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const lastError = run?.logs.findLast((line) => line.level === 'error')?.seq
  useEffect(() => {
    follow.current = true
  }, [name, run?.id])
  useEffect(() => {
    if (visible && follow.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [run?.logs, visible])
  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border',
        className
      )}
      aria-label={translate(
        'auto.components.right.sidebar.index.serverLogsTitle',
        '{{name}} Logs',
        { name }
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {translate('auto.components.right.sidebar.index.serverLogsTitle', '{{name}} Logs', {
            name
          })}
        </span>
        {lastError !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-destructive"
                aria-label={translate(
                  'auto.components.right.sidebar.index.jumpServerError',
                  'Jump to Latest Error'
                )}
                onClick={() => {
                  follow.current = false
                  errorRef.current?.scrollIntoView({ block: 'center' })
                }}
              >
                <AlertCircle size={13} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'auto.components.right.sidebar.index.jumpServerError',
                'Jump to Latest Error'
              )}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!run?.logs.length}
              aria-label={translate(
                'auto.components.right.sidebar.index.copyServerLogs',
                'Copy Logs'
              )}
              onClick={() =>
                void window.api.ui.writeClipboardText(
                  run?.logs.map((line) => line.text).join('\n') ?? ''
                )
              }
            >
              <Copy size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.right.sidebar.index.copyServerLogs', 'Copy Logs')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.right.sidebar.index.closeServerLogs',
                'Close Logs'
              )}
              onClick={onClose}
            >
              <X size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('auto.components.right.sidebar.index.closeServerLogs', 'Close Logs')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs scrollbar-sleek"
        onScroll={() => {
          const el = scrollRef.current
          if (visible && el) {
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }
        }}
      >
        {run?.logs.length ? (
          run.logs.map((line) => (
            <div
              key={line.seq}
              ref={line.seq === lastError ? errorRef : undefined}
              className={cn(
                'whitespace-pre-wrap break-words py-0.5',
                line.level === 'error' ? 'text-destructive' : 'text-foreground'
              )}
            >
              <span className="mr-2 text-muted-foreground">
                {new Date(line.time).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              {line.text}
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">
            {run
              ? translate(
                  'auto.components.right.sidebar.index.noServerLogsYet',
                  'Waiting for server output…'
                )
              : translate(
                  'auto.components.right.sidebar.index.externalServerLogs',
                  'Logs from servers started elsewhere cannot be captured retroactively. Start this server from Servers to capture its logs here.'
                )}
          </p>
        )}
      </div>
      <p className="shrink-0 border-t border-border px-2 py-1 text-3xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.index.serverLogLimit',
          'Showing up to 500 recent lines. Errors are highlighted in red.'
        )}
      </p>
    </section>
  )
}
