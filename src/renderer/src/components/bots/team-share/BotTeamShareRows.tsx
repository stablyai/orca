// An agent's people list (the Share dialog's and Settings › Sharing's): a row per person with access,
// and the Add field's suggestions.
import { createContext, useContext } from 'react'
import { Ellipsis, Mail, Search, Trash2, UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { GitHubIcon } from '../../icons/GitHubIcon'
import { LinearIcon } from '../../icons/LinearIcon'
import { SlackIcon } from '../../icons/SlackIcon'
import { BotOwnerAvatar } from '../bot-connector-people'
import {
  teamSharePersonName,
  type TeamShareLinkSource,
  type TeamShareOwner,
  type TeamSharePerson,
  type TeamShareSuggestion
} from './bot-team-share-people'

export const LINK_ICONS = { slack: SlackIcon, github: GitHubIcon, linear: LinearIcon } as const
const LINK_NAMES = { slack: 'Slack', github: 'GitHub', linear: 'Linear' } as const

/** Where the person rows sit: in the Share dialog, or in a settings inset group. */
export const TeamShareRowsInset = createContext(false)

function LinkIcons({ links }: { links: readonly TeamShareLinkSource[] }): React.JSX.Element {
  return (
    <>
      {links.map((link) => {
        const Icon = LINK_ICONS[link]
        return (
          <span
            key={link}
            role="img"
            aria-label={LINK_NAMES[link]}
            title={LINK_NAMES[link]}
            className="flex size-3 shrink-0 text-muted-foreground"
          >
            <Icon className="size-full" />
          </span>
        )
      })}
    </>
  )
}

/** The grey person avatar; Slack- or GitHub-only people wear that service's mark. */
function PersonAvatar({
  small = false,
  badge
}: {
  small?: boolean
  badge?: 'slack' | 'github'
}): React.JSX.Element {
  const BadgeIcon = badge ? LINK_ICONS[badge] : null
  const inset = useContext(TeamShareRowsInset)
  return (
    <span className={cn('relative shrink-0', small ? 'size-7' : 'size-8')}>
      <BotOwnerAvatar iconClassName={small ? 'size-3.5' : 'size-4'} />
      {BadgeIcon ? (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full p-[3px]',
            // Cut out of the surface it sits on: the popover, the dialog, or a settings inset group.
            small
              ? 'bg-popover'
              : inset
                ? 'bg-[color-mix(in_srgb,var(--foreground)_3.5%,var(--background))]'
                : 'bg-dialog-surface'
          )}
        >
          <BadgeIcon className="size-full text-muted-foreground" />
        </span>
      ) : null}
    </span>
  )
}

/** Whether the row is greyed out: someone asked who hasn't accepted, or who declined. */
function isWaiting(person: TeamSharePerson): boolean {
  return (
    person.kind === 'invite' ||
    (person.kind === 'account' && person.answer !== undefined && person.answer !== 'accepted')
  )
}

function useSubline(person: TeamSharePerson): string {
  const t = useTranslate()
  switch (person.kind) {
    case 'account':
      // Someone with access shows their email; anyone else, only where they stand.
      return person.answer === 'declined'
        ? t('bots.teamShare.declined', 'Declined')
        : person.answer === 'pending'
          ? t('bots.teamShare.invited', 'Invited')
          : person.email
    case 'invite':
      return t('bots.teamShare.invited', 'Invited')
    case 'slack':
      return person.handle
        ? t('bots.teamShare.slackLine', '{{handle}} on Slack · {{workspace}}', {
            handle: person.handle,
            workspace: person.workspace
          })
        : t('bots.teamShare.slackPlace', 'Slack · {{workspace}}', { workspace: person.workspace })
    case 'github':
      return (person.linkedAccounts ?? 0) > 1
        ? t('bots.teamShare.githubLinkedLine', 'GitHub · linked to {{count}} Orca accounts', {
            count: person.linkedAccounts
          })
        : t('bots.teamShare.githubLine', 'GitHub · {{place}}', { place: person.place })
  }
}

function RowShell({
  avatar,
  name,
  links,
  subline,
  trailing,
  muted = false
}: {
  avatar: React.ReactNode
  name: string
  links?: readonly TeamShareLinkSource[]
  subline: string
  trailing: React.ReactNode
  /** Greyed out: asked, not in yet. */
  muted?: boolean
}): React.JSX.Element {
  return (
    <li
      className={cn(
        'flex min-h-12 items-center gap-3 py-1.5',
        useContext(TeamShareRowsInset) ? 'pr-2.5 pl-3' : 'px-6'
      )}
    >
      <span className={cn('flex shrink-0', muted && 'opacity-50')}>{avatar}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[13px] leading-5 font-medium',
              muted && 'text-muted-foreground'
            )}
          >
            {name}
          </span>
          {links ? <LinkIcons links={links} /> : null}
        </div>
        <div className="truncate text-xs leading-4 text-muted-foreground">{subline}</div>
      </div>
      <div className="flex shrink-0 items-center">{trailing}</div>
    </li>
  )
}

export function TeamShareOwnerRow({ owner }: { owner: TeamShareOwner }): React.JSX.Element {
  const t = useTranslate()
  return (
    <RowShell
      avatar={<PersonAvatar />}
      name={t('bots.teamShare.you', '{{name}} (you)', { name: owner.name })}
      links={owner.links}
      subline={owner.email}
      trailing={
        <span className="pr-1 text-xs text-muted-foreground">
          {t('bots.teamShare.owner', 'Owner')}
        </span>
      }
    />
  )
}

export function TeamSharePersonRow({
  person,
  onRemove,
  onResend,
  onShareAgain
}: {
  person: TeamSharePerson
  onRemove: (person: TeamSharePerson) => void
  /** Only an invite's row offers Resend. */
  onResend?: (person: Extract<TeamSharePerson, { kind: 'invite' }>) => void
  /** Only a declined account's row offers Share again. */
  onShareAgain?: (person: Extract<TeamSharePerson, { kind: 'account' }>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const name = teamSharePersonName(person)
  const subline = useSubline(person)
  const removeLabel = t('bots.teamShare.remove', 'Remove')
  const answer = person.kind === 'account' ? (person.answer ?? 'accepted') : null
  const trailing =
    answer === 'pending' || answer === 'declined' ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('bots.teamShare.personActions', 'Actions for {{name}}', { name })}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {answer === 'declined' && person.kind === 'account' && onShareAgain ? (
            <DropdownMenuItem onSelect={() => onShareAgain(person)}>
              <UserPlus />
              {t('bots.teamShare.shareAgain', 'Share again')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(person)}>
            <Trash2 />
            {removeLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : person.kind === 'invite' && onResend ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('bots.teamShare.inviteActions', 'Invite actions for {{name}}', { name })}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onResend(person)}>
            <Mail />
            {t('bots.teamShare.resendInvite', 'Resend invite')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onRemove(person)}>
            <Trash2 />
            {removeLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('bots.teamShare.removePerson', 'Remove {{name}}', { name })}
            onClick={() => onRemove(person)}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{removeLabel}</TooltipContent>
      </Tooltip>
    )
  return (
    <RowShell
      avatar={
        <PersonAvatar
          badge={person.kind === 'slack' || person.kind === 'github' ? person.kind : undefined}
        />
      }
      name={name}
      links={person.kind === 'account' ? person.links : undefined}
      subline={subline}
      trailing={trailing}
      muted={isWaiting(person)}
    />
  )
}

/** The owner, then everyone with access, then the caller's rows (Slack- and GitHub-only people). */
export function TeamSharePeopleList({
  owner,
  people,
  onRemove,
  onResend,
  onShareAgain,
  className,
  children
}: {
  owner: TeamShareOwner | null
  people: readonly TeamSharePerson[]
  onRemove: (person: TeamSharePerson) => void
  onResend: (person: Extract<TeamSharePerson, { kind: 'invite' }>) => void
  onShareAgain: (person: Extract<TeamSharePerson, { kind: 'account' }>) => void
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <ul className={className}>
      {owner ? <TeamShareOwnerRow owner={owner} /> : null}
      {people.map((person) => (
        <TeamSharePersonRow
          key={person.key}
          person={person}
          onRemove={onRemove}
          onResend={onResend}
          onShareAgain={onShareAgain}
        />
      ))}
      {children}
    </ul>
  )
}

function useSuggestionLines(suggestion: TeamShareSuggestion): {
  title: string
  outcome: string | null
  detail: string | null
} {
  const t = useTranslate()
  switch (suggestion.kind) {
    case 'account':
      return {
        title: suggestion.name,
        outcome: t('bots.teamShare.orcaAccount', 'Orca account'),
        detail: suggestion.detail
      }
    case 'slack':
      return {
        title: suggestion.name,
        outcome: t('bots.teamShare.slackOnly', 'Slack only'),
        detail: suggestion.detail ?? null
      }
    case 'github':
      return {
        title: suggestion.name,
        outcome: t('bots.teamShare.githubOnly', 'GitHub only'),
        detail: suggestion.detail ?? null
      }
    case 'invite':
      return {
        title: t('bots.teamShare.invite', 'Invite {{email}}', { email: suggestion.email }),
        outcome: null,
        detail: null
      }
  }
}

function SuggestionAvatar({ suggestion }: { suggestion: TeamShareSuggestion }): React.JSX.Element {
  if (suggestion.kind === 'invite') {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Mail className="size-3.5" />
      </span>
    )
  }
  return <PersonAvatar small badge={suggestion.kind === 'account' ? undefined : suggestion.kind} />
}

export function TeamShareSuggestionOption({
  id,
  suggestion,
  active,
  onPick,
  onHover
}: {
  id: string
  suggestion: TeamShareSuggestion
  active: boolean
  onPick: () => void
  onHover: () => void
}): React.JSX.Element {
  const { title, outcome, detail } = useSuggestionLines(suggestion)
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      // Keep focus in the field, so typing goes on after a pointer pick.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPick}
      onMouseMove={onHover}
      className={cn(
        'flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5',
        active && 'bg-black/8 dark:bg-white/14'
      )}
    >
      <SuggestionAvatar suggestion={suggestion} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] leading-5">{title}</span>
          {suggestion.kind === 'account' ? <LinkIcons links={suggestion.links} /> : null}
          {outcome ? (
            <span className="shrink-0 text-xs text-muted-foreground">· {outcome}</span>
          ) : null}
        </div>
        {detail ? (
          <div className="truncate text-xs leading-4 text-muted-foreground">{detail}</div>
        ) : null}
      </div>
    </div>
  )
}

export function TeamShareNoMatch({ query }: { query: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Search className="size-3.5" />
      </span>
      <span className="truncate text-[13px] leading-5 text-muted-foreground">
        {t('bots.teamShare.noMatch', 'No match for {{query}}', { query })}
      </span>
    </div>
  )
}
