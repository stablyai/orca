import React, { useCallback } from 'react'
import { BadgeCheck, KeyRound, UserMinus } from 'lucide-react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { botAccessGrantFacts, type BotAccessGrant } from '../../../../shared/bots/bot-access-grant'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'
import { BotAccessReachList } from './BotAccessReach'

/** The grant, and the bot and connector whose reach the confirm lists. */
export type BotAccessConfirm = BotAccessGrant & {
  details: { bot: Bot; connector: BotAccessConnector }
}

// This window is on the computer the bot runs on.
const PLACE = { computer: BOT_ACCESS_COPY.thisComputer, there: BOT_ACCESS_COPY.here }

function AccessFacts({ grant }: { grant: BotAccessConfirm }): React.JSX.Element {
  const t = useTranslate()
  const { identity } = botAccessGrantFacts(grant)
  const factLine = 'flex gap-2.5'
  const factIcon = 'mt-0.5 size-4 shrink-0 text-muted-foreground'
  return (
    <div className="space-y-3">
      {grant.people.length > 1 ? (
        <ul className="flex flex-wrap gap-1.5">
          {grant.people.map((person) => (
            <li key={person.id} className="rounded-full border border-border px-2.5 py-0.5 text-xs">
              {person.name}
            </li>
          ))}
        </ul>
      ) : null}
      {/* The same reach list the Who can ask block shows, so both say one thing. */}
      <div className="space-y-2.5 rounded-lg border border-border p-3 text-sm">
        {identity ? (
          <p className={`${factLine} break-all`}>
            <BadgeCheck className={factIcon} aria-hidden />
            {t('bots.access.account', BOT_ACCESS_COPY.account, {
              connector: grant.connector,
              identity
            })}
          </p>
        ) : null}
        <BotAccessReachList bot={grant.details.bot} connector={grant.details.connector} />
        <p className={factLine}>
          <KeyRound className={factIcon} aria-hidden />
          {t('bots.access.yourAccess', BOT_ACCESS_COPY.yourAccess, {
            name: grant.botName,
            ...PLACE
          })}
        </p>
        <p className={factLine}>
          <UserMinus className={factIcon} aria-hidden />
          {t('bots.access.removeAnyTime', BOT_ACCESS_COPY.removeAnyTime)}
        </p>
      </div>
    </div>
  )
}

/** Adding people lets them drive the bot, and through it this computer, so it is always confirmed first. */
export function useConfirmBotAccess(): (grant: BotAccessConfirm) => Promise<boolean> {
  const confirm = useConfirmationDialog()
  return useCallback(
    (grant) => {
      const { person: one, count } = botAccessGrantFacts(grant)
      const place = grant.workspace
        ? translate('bots.access.place', BOT_ACCESS_COPY.place, {
            connector: grant.connector,
            workspace: grant.workspace
          })
        : grant.connector
      return confirm({
        surface: 'security',
        title: one
          ? translate('bots.access.titleOne', BOT_ACCESS_COPY.titleOne, {
              person: one,
              name: grant.botName
            })
          : translate('bots.access.titleMany', BOT_ACCESS_COPY.titleMany, {
              count,
              name: grant.botName
            }),
        description: one
          ? translate('bots.access.descriptionOne', BOT_ACCESS_COPY.descriptionOne, {
              person: one,
              name: grant.botName,
              place,
              ...PLACE
            })
          : translate('bots.access.descriptionMany', BOT_ACCESS_COPY.descriptionMany, {
              name: grant.botName,
              place,
              ...PLACE
            }),
        details: <AccessFacts grant={grant} />,
        confirmLabel: translate('bots.access.confirm', BOT_ACCESS_COPY.confirm),
        confirmVariant: 'destructive'
      })
    },
    [confirm]
  )
}
