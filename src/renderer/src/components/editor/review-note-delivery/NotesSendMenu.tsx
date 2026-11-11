import { useAppStore } from '@/store/index'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import type { AgentSendPopoverTargetMode } from '@/store/slices/ui/ui-slice-contract-core'
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
import { cn } from '@/lib/class-names'
import { ReviewNotesSendMenuContent } from './ReviewNotesSendMenuContent'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diff-comments/create-diff-comments-slice'
import {
  diffCommentSendKey,
  holdNotesForSend,
  isNoteInFlight,
  useNotesInFlightVersion
} from '@/components/notes/delivery/notes-send-in-flight'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { recomputeOn } from '@/lib/recompute-on'

function enabledSendTooltip(t: Translate = translate): string {
  return t('auto.components.editor.NotesSendMenu.sendNotesToAgent', 'Send notes to an agent')
}

export type NotesSendMenuScope<TNote> = {
  id: string
  label: string
  notes: readonly TNote[]
  /** The prompt for the notes this send carries: notes another send holds are left out. */
  formatPrompt: (notes: readonly TNote[]) => string
}

type SendableNotesScope<TNote> = Omit<NotesSendMenuScope<TNote>, 'formatPrompt'> & {
  prompt: string
}

export type NotesSendMenuProps<TNote> = {
  /** The copy the notes were read from; null while it is unknown, which disables Send without a message. */
  owner: DiffCommentOwner | null
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
  // Drive exactly one mounted instance with each keyboard-open nonce.
  openRequestNonce?: number | null
  // Check expiry on the opening commit; render clocks can lag or freeze.
  openRequestExpiresAt?: number | null
  onOpenRequestHandled?: () => void
  onDelivered: (notes: readonly TNote[]) => void
}

export function buildNotesSendTargetModeId(modeIdParts: readonly string[]): string {
  // Length prefixes preserve target boundaries when paths or IDs contain separators.
  return `note-send:${modeIdParts.map((part) => `${part.length}:${part}`).join('|')}`
}

export function NotesSendMenu<TNote extends DiffCommentDeliverySnapshot>({
  owner,
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
  disabledTooltip,
  iconClassName = 'size-3.5',
  align = 'end',
  openRequestNonce = null,
  openRequestExpiresAt = null,
  onOpenRequestHandled,
  onDelivered
}: NotesSendMenuProps<TNote>): React.JSX.Element {
  const t = useTranslate()
  const [sendMenuOpen, setSendMenuOpen] = useState(false)
  const targetModeId = useMemo(() => buildNotesSendTargetModeId(modeIdParts), [modeIdParts])
  const ownsTargetMode = useAppStateValue((s) => s.agentSendPopoverTargetMode?.id === targetModeId)
  const inFlightVersion = useNotesInFlightVersion()
  const sendableScopes = useMemo<SendableNotesScope<TNote>[]>(
    () =>
      recomputeOn([inFlightVersion], () =>
        scopes.map(({ formatPrompt, ...scope }) => {
          const notes = owner
            ? scope.notes.filter((note) => !isNoteInFlight(diffCommentSendKey(owner, note)))
            : []
          return { ...scope, notes, prompt: notes.length > 0 ? formatPrompt(notes) : '' }
        })
      ),
    [inFlightVersion, owner, scopes]
  )
  const enabledScopes = useMemo(
    () => sendableScopes.filter((scope) => scope.notes.length > 0),
    [sendableScopes]
  )
  const defaultScope = useMemo(() => {
    const requested = enabledScopes.find((scope) => scope.id === defaultScopeId)
    return requested ?? enabledScopes[0] ?? null
  }, [defaultScopeId, enabledScopes])
  const hasDeliverableNotes = enabledScopes.length > 0
  // Notes only on their way to an agent are not sent yet.
  const disabledTitle = !owner
    ? undefined
    : scopes.some((scope) => scope.notes.length > 0)
      ? t('components.native-chat.question.sending', 'Sending…')
      : (disabledTooltip ??
        t('auto.components.editor.NotesSendMenu.allNotesSent', 'All notes sent'))

  const markDelivered = useCallback(
    (notes: readonly TNote[]) => {
      onDelivered(notes)
    },
    [onDelivered]
  )
  const holdInFlight = useCallback(
    (notes: readonly TNote[]) => (delivered: Promise<unknown>) =>
      holdNotesForSend(
        owner ? notes.map((note) => diffCommentSendKey(owner, note)) : [],
        delivered,
        () => markDelivered(notes)
      ),
    [markDelivered, owner]
  )

  const openTargetMode = useCallback(
    (scope: SendableNotesScope<TNote>) => {
      if (scope.notes.length === 0) {
        return
      }
      useAppStore.getState().openAgentSendPopoverTargetMode({
        id: targetModeId,
        worktreeId,
        source,
        prompt: scope.prompt,
        label: targetModeLabel ?? scope.label,
        launchSource: 'notes_send',
        onPromptDelivered: () => markDelivered(scope.notes),
        onPromptHandedOff: holdInFlight(scope.notes)
      })
    },
    [holdInFlight, markDelivered, source, targetModeId, targetModeLabel, worktreeId]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setSendMenuOpen(open)
      if (open) {
        if (defaultScope) {
          openTargetMode(defaultScope)
        }
      } else {
        useAppStore.getState().closeAgentSendPopoverTargetMode(targetModeId)
      }
    },
    [defaultScope, openTargetMode, targetModeId]
  )

  const effectiveSendMenuOpen = sendMenuOpen && ownsTargetMode
  if (sendMenuOpen && !ownsTargetMode) {
    // Clear stale local open state before painting another target’s menu.
    setSendMenuOpen(false)
  }

  useEffect(
    () => () => {
      useAppStore.getState().closeAgentSendPopoverTargetMode(targetModeId)
    },
    [targetModeId]
  )

  useEffect(() => {
    if (openRequestNonce == null) {
      return
    }
    // Consume even expired or undeliverable requests so a later mount cannot reopen them.
    const expired = openRequestExpiresAt != null && Date.now() >= openRequestExpiresAt
    if (!expired && hasDeliverableNotes && defaultScope) {
      handleOpenChange(true)
    }
    onOpenRequestHandled?.()
  }, [
    openRequestNonce,
    openRequestExpiresAt,
    hasDeliverableNotes,
    defaultScope,
    handleOpenChange,
    onOpenRequestHandled
  ])

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
              title={hasDeliverableNotes ? enabledSendTooltip(t) : disabledTitle}
              aria-label={
                triggerLabel
                  ? t(
                      'auto.components.editor.NotesSendMenu.433928cd9f',
                      'Send {{value0}} to an agent',
                      { value0: triggerLabel }
                    )
                  : enabledSendTooltip(t)
              }
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
        {hasDeliverableNotes || disabledTitle ? (
          <TooltipContent side="bottom" sideOffset={6}>
            {hasDeliverableNotes ? enabledSendTooltip(t) : disabledTitle}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenuContent
        align={align}
        className="min-w-[220px]"
        onInteractOutside={preventAgentSendTargetOutsideDismiss}
        onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
      >
        {scopes.length > 1 ? (
          <>
            <DropdownMenuLabel>
              {t('auto.components.editor.NotesSendMenu.44dc5e60a6', 'Send notes')}
            </DropdownMenuLabel>
            {sendableScopes.map((scope) => (
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
                    onPromptHandedOff={holdInFlight(scope.notes)}
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
            onPromptHandedOff={holdInFlight(defaultScope?.notes ?? [])}
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
