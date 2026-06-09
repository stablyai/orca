import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { useAppStore } from '@/store'
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
import { translate } from '@/i18n/i18n'

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
  modeIdParts,
  scopes,
  defaultScopeId,
  source = 'diff-notes',
  targetModeLabel,
  triggerClassName,
  triggerLabel,
  triggerCount,
  actionLabel,
  disabledTooltip = 'All notes sent',
  iconClassName = 'size-3.5',
  align = 'end',
  onDelivered
}: NotesSendMenuProps<TNote>): React.JSX.Element {
  const openAgentSendPopoverTargetMode = useAppStore((s) => s.openAgentSendPopoverTargetMode)
  const closeAgentSendPopoverTargetMode = useAppStore((s) => s.closeAgentSendPopoverTargetMode)
  const activeTargetModeId = useAppStore((s) => s.agentSendPopoverTargetMode?.id ?? null)
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const targetModeId = useMemo(() => buildNotesSendTargetModeId(modeIdParts), [modeIdParts])
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

  const openTargetMode = useCallback(
    (scope: NotesSendMenuScope<TNote>) => {
      if (scope.notes.length === 0) {
        return
      }
      openAgentSendPopoverTargetMode({
        id: targetModeId,
        worktreeId,
        source,
        prompt: scope.prompt,
        label: targetModeLabel ?? scope.label,
        launchSource: 'notes_send',
        onPromptDelivered: () => markDelivered(scope.notes)
      })
    },
    [
      markDelivered,
      openAgentSendPopoverTargetMode,
      source,
      targetModeId,
      targetModeLabel,
      worktreeId
    ]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setSendMenuOpen(open)
      if (open) {
        if (defaultScope) {
          openTargetMode(defaultScope)
        }
      } else {
        closeAgentSendPopoverTargetMode(targetModeId)
      }
    },
    [closeAgentSendPopoverTargetMode, defaultScope, openTargetMode, targetModeId]
  )

  const effectiveSendMenuOpen = sendMenuOpen && activeTargetModeId === targetModeId
  if (sendMenuOpen && activeTargetModeId !== targetModeId) {
    // Why: avoid rendering a stale menu for one paint after another send target
    // wins; the local open bit is only meaningful while this target is active.
    setSendMenuOpen(false)
  }

  useEffect(
    () => () => {
      closeAgentSendPopoverTargetMode(targetModeId)
    },
    [closeAgentSendPopoverTargetMode, targetModeId]
  )

  return (
    <DropdownMenu modal={false} open={effectiveSendMenuOpen} onOpenChange={handleOpenChange}>
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
              aria-label={triggerLabel ? translate("auto.components.editor.NotesSendMenu.433928cd9f", "Send {{value0}} to an agent", { value0: triggerLabel }) : ENABLED_SEND_TOOLTIP}
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
      <DropdownMenuContent
        align={align}
        className="min-w-[220px]"
        onInteractOutside={preventAgentSendTargetOutsideDismiss}
        onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
      >
        {scopes.length > 1 ? (
          <>
            <DropdownMenuLabel>{translate("auto.components.editor.NotesSendMenu.44dc5e60a6", "Send notes")}</DropdownMenuLabel>
            {scopes.map((scope) => (
              <DropdownMenuSub key={scope.id}>
                <DropdownMenuSubTrigger
                  disabled={scope.notes.length === 0}
                  className="[&>svg:last-child]:ml-0"
                  onPointerEnter={() => openTargetMode(scope)}
                  onFocus={() => openTargetMode(scope)}
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

function preventAgentSendTargetOutsideDismiss(event: CustomEvent<{ originalEvent: Event }>) {
  const target = event.detail.originalEvent.target
  if (!(target instanceof Element)) {
    return
  }
  if (
    target.closest(
      '[data-agent-send-target="eligible"], [data-agent-send-target="disabled"], [data-agent-send-target="sending"]'
    )
  ) {
    event.preventDefault()
  }
}

function NoteScopeMenuRow({ label, count }: { label: string; count: number }): React.JSX.Element {
  return (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
      <span className="truncate">{label}</span>
      <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
    </span>
  )
}
