// A calm one-line row of a bot's right panel: its state as the leading icon, then its name. Details sit in
// a hover card beside the panel, which keyboard focus opens too, and in the row's accessible description.
import { Fragment, useId, useRef } from 'react'
import { CircleAlert, CircleX, MoreHorizontal, Pause } from 'lucide-react'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { upcomingAt, upcomingShort } from './bot-upcoming-copy'
import { BOT_ITEM_ROW_HOVER_ACTIONS } from './items/bot-item-row-hover-actions'
import { useBotRowCardPlacement } from './use-bot-row-card-placement'

type BotRowHoverCardProps = {
  card: React.ReactNode
  children: React.ReactElement
}

export function BotRowHoverCard(props: BotRowHoverCardProps): React.JSX.Element {
  return props.card ? <BotRowPreview {...props} /> : props.children
}

function BotRowPreview({ card, children }: BotRowHoverCardProps): React.JSX.Element {
  const placement = useBotRowCardPlacement()
  return (
    <HoverCard openDelay={400} closeDelay={80} {...placement.root}>
      <HoverCardTrigger asChild {...placement.trigger}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent {...placement.content} variant="row-details">
        {card}
      </HoverCardContent>
    </HoverCard>
  )
}

/** A card's fact: a muted lead word ("Next"), then its value. */
export type BotRowFact = { label?: string; text: string }

/** What a row's hover card says: its state, then its facts. A note is a state line without a glyph. */
export type BotRowCard = {
  state: BotRowState | { kind: 'note'; label: string } | null
  facts: readonly BotRowFact[]
}

function BotRowCardBody({ card }: { card: BotRowCard }): React.JSX.Element {
  const { state } = card
  return (
    <div className="flex flex-col gap-1">
      {state ? (
        <p className="flex items-start gap-1.5 text-foreground">
          {state.kind === 'note' ? null : (
            <span className="flex h-4 shrink-0 items-center">
              <BotRowStateIcon state={state} />
            </span>
          )}
          <span className="min-w-0">
            <span className="font-medium">{state.label}</span>
            {'reason' in state && state.reason ? ` · ${state.reason}` : null}
          </span>
        </p>
      ) : null}
      {card.facts.map((fact) => (
        <p key={`${fact.label ?? ''}${fact.text}`} className="text-foreground">
          {fact.label ? <span className="text-muted-foreground">{fact.label} </span> : null}
          {fact.text}
        </p>
      ))}
    </div>
  )
}

/** The card as one plain sentence list, for the row's accessible description. */
function botRowCardText({ state, facts }: BotRowCard): string {
  const lines = [
    state
      ? 'reason' in state && state.reason
        ? `${state.label} · ${state.reason}`
        : state.label
      : null,
    ...facts.map((fact) => (fact.label ? `${fact.label} ${fact.text}` : fact.text))
  ]
  return lines.filter(Boolean).join('. ')
}

export function BotPanelRow({
  rowKey,
  icon,
  title,
  state,
  dimmed = false,
  card,
  onOpen,
  next = null,
  actions,
  actionsShown = false,
  contextMenu
}: {
  /** Names the row for focus that moves to it after another leaves. */
  rowKey?: string
  icon: React.ReactNode
  title: string
  /** The state the icon shows, read after the name ("Reshare X post, Failed"). */
  state?: string | null
  /** Paused: icon and name quieter. */
  dimmed?: boolean
  /** Its details: the hover card and the row's description. */
  card?: BotRowCard | null
  /** Opens where its details are; without it the row stays focusable for its card and actions. */
  onOpen?: () => void
  /** Controls over the row's end on hover or keyboard focus. */
  actions?: React.ReactNode
  /** Keeps the actions shown, such as while one is busy. */
  actionsShown?: boolean
  /** Its next run, said short at the row's end ("6:30 PM"), read against the panel's clock so it
   *  rolls on with it; null when it has none to say. */
  next?: { at: number; now: number } | null
  /** Its right-click menu; none without. */
  contextMenu?: readonly BotRowMenuItem[]
}): React.JSX.Element {
  const t = useTranslate()
  const descriptionId = useId()
  const label = [
    title,
    state,
    next
      ? t('bots.automations.nextAt', 'next {{time}}', { time: upcomingAt(next.at, next.now) })
      : null
  ]
    .filter(Boolean)
    .join(', ')
  const keyboardTitle = useRef<HTMLButtonElement | null>(null)
  const restoreOnEscape = useRef(false)
  const hasContextMenu = Boolean(contextMenu?.length)
  const canOpenContextMenu = contextMenu?.some((item) => !item.disabled)
  const openKeyboardMenu = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'F10' || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }
    event.preventDefault()
    if (!canOpenContextMenu || event.repeat) {
      return
    }
    const titleButton = event.currentTarget
    const anchor = titleButton.closest('[data-bot-panel-row]') ?? titleButton
    const { left, bottom } = anchor.getBoundingClientRect()
    keyboardTitle.current = titleButton
    // Use the existing Radix trigger so keyboard and pointer share menu ownership and positioning.
    titleButton.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: left,
        clientY: bottom
      })
    )
  }
  const closeContextMenu = (event: Event): void => {
    const titleButton = keyboardTitle.current
    const restore = restoreOnEscape.current
    keyboardTitle.current = null
    restoreOnEscape.current = false
    if (restore && titleButton?.isConnected) {
      event.preventDefault()
      const active = titleButton.ownerDocument.activeElement
      if (!active || active === titleButton.ownerDocument.body || active === titleButton) {
        titleButton.focus()
      }
    }
  }
  const row = (
    <div
      data-bot-panel-row={rowKey}
      className={cn(
        'group/item relative flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent has-[[data-state=open]]:bg-accent',
        hasContextMenu &&
          'has-[[data-bot-row-open]:focus-visible]:ring-1 has-[[data-bot-row-open]:focus-visible]:ring-ring has-[[data-bot-row-open]:focus-visible]:ring-inset'
      )}
    >
      <span
        className={cn('flex h-5 w-4 shrink-0 items-center justify-center', dimmed && 'opacity-60')}
      >
        {icon}
      </span>
      <BotRowHoverCard card={card ? <BotRowCardBody card={card} /> : null}>
        <button
          type="button"
          data-activity-row-key={rowKey}
          aria-label={label === title ? undefined : label}
          aria-describedby={card ? descriptionId : undefined}
          aria-disabled={onOpen ? undefined : true}
          aria-keyshortcuts={canOpenContextMenu ? 'Shift+F10' : undefined}
          data-bot-row-open={onOpen ? '' : undefined}
          className={cn(
            'min-w-0 flex-1 truncate rounded-sm text-left text-[13px] leading-5 focus-visible:outline-none',
            !hasContextMenu && 'focus-visible:ring-1 focus-visible:ring-ring',
            onOpen ? 'cursor-pointer' : 'cursor-default',
            dimmed ? 'text-muted-foreground' : 'text-foreground'
          )}
          onClick={onOpen}
          onKeyDown={hasContextMenu ? openKeyboardMenu : undefined}
        >
          {title}
        </button>
      </BotRowHoverCard>
      {next ? (
        // The actions lay over it on hover or focus; invisible, it keeps the name's cut where it was.
        <span
          aria-hidden
          className={cn(
            'shrink-0 whitespace-nowrap text-xs leading-5 tabular-nums text-muted-foreground',
            actionsShown
              ? 'invisible'
              : 'group-has-[:focus-visible]/item:invisible group-hover/item:invisible group-has-[[aria-expanded=true]]/item:invisible'
          )}
        >
          {upcomingShort(next.at, next.now)}
        </span>
      ) : null}
      {card ? (
        <span id={descriptionId} hidden>
          {botRowCardText(card)}
        </span>
      ) : null}
      {actions ? (
        <span
          className={cn(
            BOT_ITEM_ROW_HOVER_ACTIONS,
            'gap-0.5 has-[[data-state=open]]:flex',
            actionsShown && 'flex'
          )}
        >
          {actions}
        </span>
      ) : null}
    </div>
  )
  if (!contextMenu || contextMenu.length === 0) {
    return row
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          if (event.nativeEvent.isTrusted) {
            keyboardTitle.current = null
          }
        }}
      >
        {row}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        onEscapeKeyDown={() => {
          restoreOnEscape.current = keyboardTitle.current !== null
        }}
        onCloseAutoFocus={closeContextMenu}
      >
        {contextMenu.map((item) => (
          <ContextMenuItem
            key={item.label}
            variant={item.variant}
            disabled={item.disabled}
            onSelect={item.onSelect}
          >
            {item.icon}
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** What a row's leading icon says in place of its kind; null shows the kind. */
export type BotRowState =
  | { kind: 'failed'; label: string; reason?: string | null }
  /** Won't run, needs sign-in, stopped at a usage limit. */
  | { kind: 'alert'; label: string; reason?: string | null }
  | { kind: 'running'; label: string }
  | { kind: 'paused'; label: string }
  /** Being deleted; never trouble, never dimmed. */
  | { kind: 'deleting'; label: string }

/** Failed and alert rows stay listed under a folded section. */
export const isBotRowTrouble = (state: BotRowState | null): boolean =>
  state?.kind === 'failed' || state?.kind === 'alert'

const GLYPH = 'size-3.5 shrink-0'

/** The state's glyph, the only color on a calm row; `kind` shows while it has none. */
export function BotRowStateIcon({
  state,
  kind
}: {
  state: BotRowState | null
  kind?: React.ReactNode
}): React.JSX.Element | null {
  if (!state) {
    return kind ? <>{kind}</> : null
  }
  switch (state.kind) {
    case 'failed':
      return <CircleX aria-hidden className={cn(GLYPH, 'text-destructive')} />
    case 'alert':
      return <CircleAlert aria-hidden className={cn(GLYPH, 'text-agent-question')} />
    case 'running':
      return <AgentWorkingSpinner className="size-3 shrink-0" />
    case 'paused':
      return <Pause aria-hidden className={cn(GLYPH, 'text-muted-foreground')} />
    case 'deleting':
      return (
        <span aria-hidden className="flex">
          <AgentWorkingSpinner className="size-3 shrink-0" />
        </span>
      )
  }
}

/** An icon-only row action, named by its tooltip. */
export function BotRowIconButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export type BotRowMenuItem = {
  icon: React.ReactNode
  label: string
  onSelect: () => void
  disabled?: boolean
  variant?: 'destructive'
}

/** A row's ⋯ menu: its commands, then a separator before where it opens. */
export function BotRowMoreMenu({
  groups
}: {
  groups: readonly (readonly BotRowMenuItem[])[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={t('bots.items.row.more', 'More')}>
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {groups
          .filter((group) => group.length > 0)
          .map((group, index) => (
            <Fragment key={group[0].label}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {group.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  variant={item.variant}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  {item.icon}
                  {item.label}
                </DropdownMenuItem>
              ))}
            </Fragment>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
