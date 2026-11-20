// A calm one-line row of a bot's right panel: its state as the leading icon, then its name. Details sit in
// a hover card beside the panel, which keyboard focus opens too, and in the row's accessible description.
import { Fragment, useId } from 'react'
import { CircleAlert, CircleX, MoreHorizontal, Pause } from 'lucide-react'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { Button } from '@/components/ui/button'
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
  icon,
  title,
  state,
  dimmed = false,
  card,
  onOpen,
  actions,
  actionsShown = false
}: {
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
}): React.JSX.Element {
  const descriptionId = useId()
  return (
    <div className="group/item relative flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent has-[:focus-visible]:bg-accent has-[[data-state=open]]:bg-accent">
      <span
        className={cn('flex h-5 w-4 shrink-0 items-center justify-center', dimmed && 'opacity-60')}
      >
        {icon}
      </span>
      <BotRowHoverCard card={card ? <BotRowCardBody card={card} /> : null}>
        <button
          type="button"
          aria-label={state ? `${title}, ${state}` : undefined}
          aria-describedby={card ? descriptionId : undefined}
          aria-disabled={onOpen ? undefined : true}
          className={cn(
            'min-w-0 flex-1 truncate rounded-sm text-left text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            onOpen ? 'cursor-pointer' : 'cursor-default',
            dimmed ? 'text-muted-foreground' : 'text-foreground'
          )}
          onClick={onOpen}
        >
          {title}
        </button>
      </BotRowHoverCard>
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
}

/** What a row's leading icon says in place of its kind; null shows the kind. */
export type BotRowState =
  | { kind: 'failed'; label: string; reason?: string | null }
  /** Won't run, needs sign-in, stopped at a usage limit. */
  | { kind: 'alert'; label: string; reason?: string | null }
  | { kind: 'running'; label: string }
  | { kind: 'paused'; label: string }

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
