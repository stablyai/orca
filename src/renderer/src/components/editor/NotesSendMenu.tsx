import React, { useCallback, useMemo, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import type { AgentSendPopoverTargetMode } from '@/store/slices/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ReviewNotesSendMenuContent } from './ReviewNotesSendMenuContent'

const ENABLED_SEND_TOOLTIP = 'Send notes to an agent'

export type NotesSendMenuScope<TNote> = {
  id: string
  label: string
  notes: readonly TNote[]
  prompt: string
}

export type NotesSendMenuProps<TNote> = {
  worktreeId: string
  groupId: string
  modeIdParts: readonly string[]
  scopes: readonly NotesSendMenuScope<TNote>[]
  defaultScopeId?: string
  source?: AgentSendPopoverTargetMode['source']
  targetModeLabel?: string
  triggerClassName?: string
  triggerLabel?: string
  triggerCount?: number
  actionLabel?: string
  disabledTooltip?: string
  iconClassName?: string
  align?: 'start' | 'center' | 'end'
  onDelivered: (notes: readonly TNote[]) => void
}

export function buildNotesSendTargetModeId(modeIdParts: readonly string[]): string {
  // Why: length-prefixing preserves part boundaries even when paths or ids
  // contain the separator, keeping unrelated note send targets distinct.
  return `note-send:${modeIdParts.map((part) => `${part.length}:${part}`).join('|')}`
}

export function NotesSendMenu<TNote>({
  worktreeId,
  groupId,
  scopes,
  defaultScopeId,
  triggerClassName,
  triggerLabel,
  triggerCount,
  actionLabel,
  disabledTooltip = 'All notes sent',
  iconClassName = 'size-3.5',
  align = 'end',
  onDelivered
}: NotesSendMenuProps<TNote>): React.JSX.Element {
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const enabledScopes = useMemo(() => scopes.filter((scope) => scope.notes.length > 0), [scopes])
  const defaultScope = useMemo(() => {
    const requested = enabledScopes.find((scope) => scope.id === defaultScopeId)
    return requested ?? enabledScopes[0] ?? null
  }, [defaultScopeId, enabledScopes])
  const hasDeliverableNotes = enabledScopes.length > 0

  const markDelivered = useCallback(
    (notes: readonly TNote[]) => {
      onDelivered(notes)
    },
    [onDelivered]
  )

  const handleOpenChange = useCallback((open: boolean) => {
    setSendMenuOpen(open)
  }, [])

  return (
    <DropdownMenu modal={false} open={sendMenuOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
                triggerClassName
              )}
              disabled={!hasDeliverableNotes}
              title={hasDeliverableNotes ? ENABLED_SEND_TOOLTIP : disabledTooltip}
              aria-label={triggerLabel ? `Send ${triggerLabel} to an agent` : ENABLED_SEND_TOOLTIP}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              {triggerLabel ? (
                <>
                  <Sparkles className="size-3 text-violet-500 dark:text-violet-400" />
                  <span className="whitespace-nowrap">{triggerLabel}</span>
                  {triggerCount !== undefined ? (
                    <span className="rounded-full bg-background/80 px-1 text-[10px] tabular-nums text-muted-foreground">
                      {triggerCount}
                    </span>
                  ) : null}
                  <span className="mx-0.5 h-3 w-px bg-border/70" aria-hidden />
                </>
              ) : null}
              <Send className={iconClassName} />
              {actionLabel ? <span className="whitespace-nowrap">{actionLabel}</span> : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {hasDeliverableNotes ? ENABLED_SEND_TOOLTIP : disabledTooltip}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="min-w-[220px]">
        {scopes.length > 1 ? (
          <>
            <DropdownMenuLabel>Send notes</DropdownMenuLabel>
            {scopes.map((scope) => (
              <DropdownMenuSub key={scope.id}>
                <DropdownMenuSubTrigger
                  disabled={scope.notes.length === 0}
                  className="[&>svg:last-child]:ml-0"
                >
                  <NoteScopeMenuRow label={scope.label} count={scope.notes.length} />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[180px]">
                  <ReviewNotesSendMenuContent
                    worktreeId={worktreeId}
                    groupId={groupId}
                    prompt={scope.prompt}
                    promptDelivery="submit-after-ready"
                    launchSource="notes_send"
                    onPromptDelivered={() => markDelivered(scope.notes)}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </>
        ) : (
          <ReviewNotesSendMenuContent
            worktreeId={worktreeId}
            groupId={groupId}
            prompt={defaultScope?.prompt ?? ''}
            promptDelivery="submit-after-ready"
            launchSource="notes_send"
            onPromptDelivered={() => {
              if (defaultScope) {
                markDelivered(defaultScope.notes)
              }
            }}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function NoteScopeMenuRow({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
      <span className="truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </span>
  )
}
