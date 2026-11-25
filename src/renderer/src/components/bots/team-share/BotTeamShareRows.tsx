// The Share dialog's rows: one per person with access, and the Add field's suggestions.
import {
  CircleCheck,
  CircleX,
  Clock,
  Ellipsis,
  Mail,
  Search,
  Trash2,
  UserPlus,
  X,
  type LucideIcon
} from 'lucide-react'
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
  type TeamShareAnswer,
  type TeamShareOwner,
  type TeamSharePerson,
  type TeamShareSuggestion
} from './bot-team-share-people'

const LINK_ICONS = { slack: SlackIcon, github: GitHubIcon, linear: LinearIcon } as const
const LINK_NAMES = { slack: 'Slack', github: 'GitHub', linear: 'Linear' } as const

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
  return (
    <span className={cn('relative shrink-0', small ? 'size-7' : 'size-8')}>
      <BotOwnerAvatar iconClassName={small ? 'size-3.5' : 'size-4'} />
      {BadgeIcon ? (
        <span
          className={cn(
            'absolute -right-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full p-[3px]',
            // Cut out of the surface it sits on: suggestions are on the popover, rows on the dialog.
            small ? 'bg-popover' : 'bg-dialog-surface'
          )}
        >
          <BadgeIcon className="size-full text-muted-foreground" />
        </span>
      ) : null}
    </span>
  )
}

// Where a person stands, on the row's second line: color only on its icon.
const ANSWER_ICONS: Record<TeamShareAnswer, { icon: LucideIcon; className: string }> = {
  accepted: { icon: CircleCheck, className: 'text-status-success' },
  pending: { icon: Clock, className: 'text-status-warning' },
  declined: { icon: CircleX, className: 'text-destructive' }
}

function StateLine({
  icon: Icon,
  className,
  text
}: {
  icon: LucideIcon
  className?: string
  text: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
      <Icon className={cn('size-3 shrink-0', className)} aria-hidden />
      <span className="min-w-0 truncate">{text}</span>
    </div>
  )
}

function useSubline(person: TeamSharePerson): React.ReactNode {
  const t = useTranslate()
  switch (person.kind) {
    case 'account': {
      const answer = person.answer ?? 'accepted'
      const words = {
        accepted: t('bots.teamShare.hasAccess', 'Has access'),
        pending: t('bots.teamShare.waitingToAccept', 'Waiting to accept'),
        declined: t('bots.teamShare.declined', 'Declined')
      }[answer]
      return <StateLine {...ANSWER_ICONS[answer]} text={`${words} · ${person.email}`} />
    }
    case 'invite':
      return (
        <StateLine
          icon={Mail}
          text={
            person.emailSent
              ? t('bots.teamShare.invited', 'Invited')
              : t('bots.teamShare.emailNotSent', 'Email not sent yet')
          }
        />
      )
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
  trailing
}: {
  avatar: React.ReactNode
  name: string
  links?: readonly TeamShareLinkSource[]
  subline: React.ReactNode
  trailing: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex min-h-12 items-center gap-3 px-6 py-1.5">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] leading-5 font-medium">{name}</span>
          {links ? <LinkIcons links={links} /> : null}
        </div>
        {typeof subline === 'string' ? (
          <div className="truncate text-xs leading-4 text-muted-foreground">{subline}</div>
        ) : (
          subline
        )}
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
    />
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
