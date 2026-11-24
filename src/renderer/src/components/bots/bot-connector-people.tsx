import React, { useState } from 'react'
import { Bot, UserRound, X } from 'lucide-react'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { useTranslate } from '@/i18n/use-translate'
import { useBotConnectorPaged } from './bot-connector-page'
import type { BotMember } from '../../../../shared/bot-types'
import { botMemberAvatarUrl } from '../../../../shared/bots/bot-member-avatar-url'

// Chips past these show as "+N": four people after You when open, three avatars when closed.
const CHIP_LIMIT = 4
const STACK_LIMIT = 3

const memberName = (member: BotMember): string => member.name || member.id

/** An open connector's small caption label, e.g. HOW TO ASK, with an optional count and action. */
export function BotConnectorCaption(props: {
  title: string
  count?: number
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-0.5 flex h-6 items-center justify-between gap-2">
      <p className="text-2xs font-semibold text-muted-foreground">
        {props.title}
        {props.count === undefined ? null : <span className="ml-1 font-medium">{props.count}</span>}
      </p>
      {props.action}
    </div>
  )
}

/**
 * One part of a connector's body: a caption, then its content; on the connector's own page the
 * content sits in a card. Elsewhere (a folding row, a setup dialog) it reads as before.
 */
export function BotConnectorSection(props: {
  title?: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const paged = useBotConnectorPaged()
  const caption = props.title ? (
    <BotConnectorCaption title={props.title} count={props.count} action={props.action} />
  ) : null
  if (!paged) {
    return (
      <>
        {caption}
        {props.children}
      </>
    )
  }
  return (
    // A part with nothing to show (e.g. no picker yet) leaves no empty card.
    <section className="mt-3.5 flex min-w-0 flex-col has-[>div:empty]:hidden">
      {caption}
      <div className="min-w-0 rounded-[10px] border border-border bg-card p-3 *:last:mb-0">
        {props.children}
      </div>
    </section>
  )
}

/** The owner, as a person icon. */
export function BotOwnerAvatar(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <UserRound className="size-3" />
    </span>
  )
}

/** A person with access: their picture, else their initials; an app without one, a bot icon. */
export function BotMemberAvatar({ member }: { member: BotMember }): React.JSX.Element {
  return (
    <ConnectorAvatar
      avatarUrl={botMemberAvatarUrl(member)}
      name={memberName(member)}
      className="size-full"
      fallback={
        member.kind === 'app' ? (
          <span
            aria-hidden
            className="flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Bot className="size-3" />
          </span>
        ) : undefined
      }
    />
  )
}

/** A closed connector row's people: "Only you", or the first few as avatars, then "+N". */
export function BotPeopleStack({ members }: { members: readonly BotMember[] }): React.JSX.Element {
  const t = useTranslate()
  const count = members.length + 1
  const label = t('settings.bots.connectorPeopleCount', '{{count}} with access', { count })
  if (members.length === 0) {
    return (
      <span className="w-19 shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground">
        <span className="sr-only">{label}</span>
        <span aria-hidden>{t('settings.bots.connectorOnlyYou', 'Only you')}</span>
      </span>
    )
  }
  const shown = members.slice(0, STACK_LIMIT - 1)
  return (
    <span className="flex w-19 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span className="sr-only">{label}</span>
      <span aria-hidden className="flex -space-x-1">
        <span className="size-5 rounded-full ring-2 ring-card">
          <BotOwnerAvatar />
        </span>
        {shown.map((member) => (
          <span key={member.id} className="size-5 rounded-full ring-2 ring-card">
            <BotMemberAvatar member={member} />
          </span>
        ))}
      </span>
      {count > STACK_LIMIT ? <span aria-hidden>+{count - STACK_LIMIT}</span> : null}
    </span>
  )
}

const CHIP_CLASSES =
  'group/chip inline-flex h-7 max-w-60 items-center gap-1.5 rounded-full border border-border pr-2.5 pl-0.5 text-xs dark:border-input'

/** People with access as wrapping chips: the owner first, then a few, then "+N" that shows the rest in place. */
export function BotPeopleChips({
  owner,
  members,
  onRemove,
  add,
  ownerTag = true
}: {
  /** You, or the owner's name there when this device is on another account. */
  owner: string
  members: readonly BotMember[]
  onRemove: (member: BotMember) => void
  /** The Add control, last in the row. */
  add?: React.ReactNode
  /** "· Owner" after the owner's name. */
  ownerTag?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? members : members.slice(0, CHIP_LIMIT)
  const hidden = members.length - shown.length
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5">
      <li className={CHIP_CLASSES}>
        <span className="size-5.5 shrink-0">
          <BotOwnerAvatar />
        </span>
        <span className="truncate">{owner}</span>
        {ownerTag ? (
          <span className="shrink-0 text-muted-foreground">
            · {t('bots.whoCanAsk.owner', 'Owner')}
          </span>
        ) : null}
      </li>
      {shown.map((member) => (
        <li key={member.id} className={CHIP_CLASSES}>
          {/* The avatar turns into × on hover or focus, so the chip never changes width. */}
          <span className="relative size-5.5 shrink-0">
            <span className="block size-full group-focus-within/chip:invisible group-hover/chip:invisible">
              <BotMemberAvatar member={member} />
            </span>
            <button
              type="button"
              aria-label={t('bots.whoCanAsk.removePerson', 'Remove {{name}}', {
                name: memberName(member)
              })}
              onClick={() => onRemove(member)}
              className="absolute inset-0 flex items-center justify-center rounded-full bg-muted text-foreground opacity-0 outline-none group-hover/chip:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <X className="size-3" />
            </button>
          </span>
          <span className="truncate">{memberName(member)}</span>
        </li>
      ))}
      {hidden > 0 ? (
        <li>
          <button
            type="button"
            aria-label={t('bots.whoCanAsk.showMore', 'Show {{count}} more', {
              count: hidden
            })}
            onClick={() => setShowAll(true)}
            className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:border-input"
          >
            +{hidden}
          </button>
        </li>
      ) : null}
      {add ? <li>{add}</li> : null}
    </ul>
  )
}
