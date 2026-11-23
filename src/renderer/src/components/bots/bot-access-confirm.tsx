import React, { useCallback } from 'react'
import {
  GitPullRequest,
  Laptop,
  Mail,
  MessageSquare,
  ShieldAlert,
  ShieldOff,
  SquarePen
} from 'lucide-react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { DialogDescription } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useHostBots } from '@/lib/bot-catalog'
import type { Bot } from '../../../../shared/bot-types'
import { botAccessGrantFacts, type BotAccessGrant } from '../../../../shared/bots/bot-access-grant'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import {
  botAccessConfirm,
  type BotAccessConfirmRow,
  type BotAccessConnector
} from '../../../../shared/bots/bot-access-reach'
import { useBotAccessSignals } from './BotAccessReach'
import { useBotAccessPlace } from './use-bot-access-place'

/** The grant, and the bot and connector whose reach the confirm lists. */
export type BotAccessConfirm = BotAccessGrant & {
  details: { bot: Bot; connector: BotAccessConnector }
}

// Fixed palette values, not theme tokens: the security surface keeps plugin themes from restyling them.
const TONE = {
  high: {
    tile: 'bg-red-600/16 text-red-600 dark:bg-red-400/16 dark:text-red-400',
    icon: 'text-red-600 dark:text-red-400',
    ink: 'text-red-800 dark:text-red-200'
  },
  medium: {
    tile: 'bg-amber-700/16 text-amber-700 dark:bg-amber-400/16 dark:text-amber-400',
    icon: 'text-amber-700 dark:text-amber-400',
    ink: 'text-amber-800 dark:text-amber-200'
  }
} as const

function useAccessConfirm(grant: BotAccessConfirm): ReturnType<typeof botAccessConfirm> {
  const asked = grant.details.bot
  // The bot as listed now, so a setting changed while this is open shows; the people stay as asked.
  const listed = useHostBots(asked.hostId).find((bot) => bot.id === asked.id)
  const { permission, google, googleUnknown } = useBotAccessSignals(listed ?? asked)
  return botAccessConfirm({
    // No longer listed: its settings can't be read, so it may never ask and Google may reach anything.
    permission: listed ? permission : { mode: null, fellBackFrom: null },
    connector: grant.details.connector,
    // Unknown counts: until the status loads, Google may reach anything.
    google: !listed || google.length > 0 || googleUnknown
  })
}

/** The shield tile beside the title, in the grant's tone. */
function AccessTile({ grant }: { grant: BotAccessConfirm }): React.JSX.Element {
  const { tone } = useAccessConfirm(grant)
  return (
    <span
      aria-hidden
      className={cn('grid size-9 shrink-0 place-items-center rounded-[10px]', TONE[tone].tile)}
    >
      <ShieldAlert className="size-5" />
    </span>
  )
}

/** "@neil · Slack (Stably)": who, which truncates, then where, which doesn't. */
function AccessWho({
  grant,
  place
}: {
  grant: BotAccessConfirm
  place: string
}): React.JSX.Element {
  const { person, firstName, names, identity } = botAccessGrantFacts(grant)
  // Without a handle, the full name, since the title shows only the first.
  const who = person ? (identity ?? (person !== firstName ? person : null)) : names.join(', ')
  return (
    <p className="flex min-w-0 whitespace-nowrap">
      {who ? (
        <span className="min-w-0 truncate" title={who}>
          {who}
        </span>
      ) : null}
      <span className="max-w-full shrink-0 truncate">
        {who ? ' · ' : null}
        {place}
      </span>
    </p>
  )
}

// Literal keys, so a language pack can't reword what this security prompt says (protected copy).
function connectorRow(
  t: Translate,
  connector: BotAccessConnector,
  name: string
): { text: string; Icon: React.ElementType } {
  switch (connector) {
    case 'slack':
      return {
        text: t('bots.access.reachSlack', BOT_ACCESS_COPY.reachSlack, { name }),
        Icon: MessageSquare
      }
    case 'github':
      return {
        text: t('bots.access.confirmGitHub', BOT_ACCESS_COPY.confirmGitHub),
        Icon: GitPullRequest
      }
    case 'linear':
      return {
        text: t('bots.access.confirmLinear', BOT_ACCESS_COPY.confirmLinear),
        Icon: SquarePen
      }
  }
}

function rowWords(
  t: Translate,
  grant: BotAccessConfirm,
  row: BotAccessConfirmRow
): { text: string; Icon: React.ElementType; warn?: true } {
  switch (row.kind) {
    case 'computer':
      return {
        text: t('bots.access.confirmComputer', BOT_ACCESS_COPY.confirmComputer),
        Icon: Laptop
      }
    case 'no-approvals':
      return {
        text: t('bots.access.confirmNoApprovals', BOT_ACCESS_COPY.confirmNoApprovals),
        Icon: ShieldOff,
        warn: true
      }
    case 'may-skip-approvals':
      return {
        text: t('bots.access.confirmMaySkipApprovals', BOT_ACCESS_COPY.confirmMaySkipApprovals),
        Icon: ShieldAlert,
        warn: true
      }
    case 'approves': {
      const { firstName } = botAccessGrantFacts(grant)
      return {
        text: firstName
          ? t('bots.access.confirmApproveOne', BOT_ACCESS_COPY.confirmApproveOne, {
              person: firstName
            })
          : t('bots.access.confirmApproveMany', BOT_ACCESS_COPY.confirmApproveMany),
        Icon: ShieldAlert
      }
    }
    case 'google':
      return { text: t('bots.access.confirmGoogle', BOT_ACCESS_COPY.confirmGoogle), Icon: Mail }
    case 'connector':
      return connectorRow(t, row.connector, grant.botName)
  }
}

/** One warning line, which describes the dialog, then what they reach, one line each. */
function AccessFacts({ grant }: { grant: BotAccessConfirm }): React.JSX.Element {
  const t = useTranslate()
  const place = useBotAccessPlace(grant.details.bot.hostId)
  const { tone, rows } = useAccessConfirm(grant)
  return (
    <div className="mt-0.5 min-w-0">
      {/* The description keeps its own type; the tone and weight sit on the line inside it. */}
      <DialogDescription asChild>
        <p className="flex items-center gap-2">
          <ShieldAlert className={cn('size-4 shrink-0', TONE[tone].icon)} aria-hidden />
          <span className={cn('min-w-0 text-sm leading-5 font-medium', TONE[tone].ink)}>
            {t('bots.access.confirmWarning', BOT_ACCESS_COPY.confirmWarning, place)}
          </span>
        </p>
      </DialogDescription>
      <ul className="mt-2.5 flex flex-col gap-2 text-sm leading-5">
        {rows.map((row) => {
          const { text, Icon, warn } = rowWords(t, grant, row)
          return (
            <li key={row.kind} className="flex min-w-0 items-center gap-2.5">
              <Icon
                className={cn('size-4 shrink-0', warn ? TONE.high.icon : 'text-muted-foreground')}
                aria-hidden
              />
              <span className="min-w-0 truncate" title={text}>
                {text}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Adding people lets them drive the bot, and through it this computer, so it is always confirmed first. */
// Each confirm mounts its own tile and facts, so each reads Google afresh, even one queued right
// behind another while the dialog stays open.
let confirmsOpened = 0
function nextConfirmKey(): number {
  confirmsOpened += 1
  return confirmsOpened
}

/** `onReject`, for a confirm that answers a request: its dismiss button reads Reject and declines it,
 *  while Escape or a press outside still leaves the request waiting. */
export function useConfirmBotAccess(): (
  grant: BotAccessConfirm,
  onReject?: () => void
) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    (grant, onReject) => {
      const { firstName, count } = botAccessGrantFacts(grant)
      const opened = nextConfirmKey()
      const place = grant.workspace
        ? translate('bots.access.place', BOT_ACCESS_COPY.place, {
            connector: grant.connector,
            workspace: grant.workspace
          })
        : grant.connector
      return confirm({
        surface: 'security',
        // The first name, so a long name can't wrap the title; the full one is in the line under it.
        title: firstName
          ? translate('bots.access.titleOne', BOT_ACCESS_COPY.titleOne, {
              person: firstName,
              name: grant.botName
            })
          : translate('bots.access.titleMany', BOT_ACCESS_COPY.titleMany, {
              count,
              name: grant.botName
            }),
        media: <AccessTile key={opened} grant={grant} />,
        subtitle: <AccessWho grant={grant} place={place} />,
        details: <AccessFacts key={opened} grant={grant} />,
        confirmLabel: translate('bots.access.confirm', BOT_ACCESS_COPY.confirm),
        confirmVariant: 'destructive',
        ...(onReject
          ? {
              cancelLabel: translate('bots.access.reject', BOT_ACCESS_COPY.reject),
              onCancelClicked: onReject,
              // Both buttons answer: a held Enter or a double-click on Review… must answer neither.
              ignoresOpeningGesture: 'buttons' as const
            }
          : {})
      })
    },
    [confirm]
  )
}
