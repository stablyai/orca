import React from 'react'
import { Loader2, Plus, TriangleAlert, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { refreshAccessRequests, type HostAccessRequest } from '@/lib/bot-access-requests'
import type { Bot, BotMember } from '../../../../shared/bot-types'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import { BotConnectorCaption, BotPeopleChips } from './bot-connector-people'
import { BotAccessDetails, BotAccessSummary } from './BotAccessReach'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'
import { AttentionDot } from './AttentionDot'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import { OrcaCloudSignInLine } from './orca-cloud-sign-in'
import { accessRequestPerson } from '../../../../shared/bots/bot-access-request'
import { requestLine, useBotWhoCanAsk } from './use-bot-who-can-ask'

/** complete is false when the service's people are too many to read whole. */
export type BotWhoCanAskFound = {
  /** `outside`: found only by an exact lookup, not among the people this connector works with. */
  members: { id: string; name: string; handle?: string; avatarUrl?: string; outside?: boolean }[]
  complete: boolean
}

/** One connector's people: who is listed, how to find more, and what the card says around them. */
export type BotWhoCanAskService = {
  /** The people this connector lets ask the bot; new ones are saved with `stamp`. */
  listed: (members: readonly BotMember[]) => BotMember[]
  stamp: Pick<BotMember, 'source' | 'workspaceId'>
  /** How many people this connector takes, within the bot's BOT_MAX_MEMBERS overall. */
  max: number
  search: (query: string) => Promise<BotSlackResult<BotWhoCanAskFound>>
  errorMessage: (code: string) => string
  searchPlaceholder: string
  /** The picker's heading over found people, e.g. "People in Globex". */
  peopleHeading: string
  /** The heading over `outside` people, kept apart so a stranger never reads as a teammate. */
  outsideHeading?: string
  /** What an empty search says, naming the query and where it looked. */
  noMatch: (query: string) => { title: string; detail: string }
  /** Shown while the search box is empty and the service suggests nobody. */
  idleHint?: { title: string; detail: string }
  /** The owner's own account here, listed as the owner rather than offered; null when unknown. */
  ownerId: string | null
  /** Its name there, e.g. "@orca-bots"; null when unknown. */
  ownerName: string | null
  kind: BotAccessConnector
  /** Named in the access confirmation, e.g. "Slack" and its workspace. */
  connector: string
  workspace: string | null
  /** What everyone else there gets; null until the bot is reachable there, when `notYet` shows. */
  outsiders: string | null
  notYet: string
  /** Whose Request access this list answers: the connector and workspace the bot is in now. */
  accessRequests?: {
    source: HostAccessRequest['source']
    workspaceId: string
  } | null
}

/** People who pressed Request access, as their connector vouched for them; the owner decides each. */
function AccessRequestRows({
  requests,
  onReview,
  onDecline
}: {
  requests: readonly HostAccessRequest[]
  onReview: (request: HostAccessRequest) => void
  onDecline: (request: HostAccessRequest) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <BotConnectorCaption
        title={t('bots.accessRequest.heading', BOT_ACCESS_COPY.heading)}
        count={requests.length}
      />
      <ul className="mb-4">
        {requests.map((request) => (
          <li key={request.requestId} className="flex h-9 items-center gap-2 text-sm">
            <AttentionDot />
            <span className="min-w-0 flex-1 truncate">
              {accessRequestPerson(request)}
              <span className="ml-1.5 text-xs text-muted-foreground">{requestLine(request)}</span>
            </span>
            <Button size="xs" variant="ghost" onClick={() => onDecline(request)}>
              {t('bots.accessRequest.decline', BOT_ACCESS_COPY.decline)}
            </Button>
            <Button size="xs" onClick={() => onReview(request)}>
              {t('bots.accessRequest.reviewButton', BOT_ACCESS_COPY.review)}
            </Button>
          </li>
        ))}
      </ul>
    </>
  )
}

/** Who can ask the bot on one connector, as every surface shows it: the requests waiting, one summary,
 *  the people with Add, then advice and what they reach. Adding is always confirmed first. */
export function BotWhoCanAskList({
  bot,
  service
}: {
  bot: Bot
  service: BotWhoCanAskService
}): React.JSX.Element {
  const t = useTranslate()
  const {
    owner,
    listed,
    requests,
    requestsWaitOnSignIn,
    pickerOpen,
    setPickerOpen,
    save,
    saving,
    cap,
    capped,
    keptOnlyMe,
    add,
    review,
    remove,
    keepOnlyMe,
    decline
  } = useBotWhoCanAsk(bot, service)
  return (
    <>
      {requests.length > 0 ? (
        <AccessRequestRows requests={requests} onReview={review} onDecline={decline} />
      ) : null}
      {/* Requests come through Orca Cloud: signed out, nobody's shows, so say why. */}
      {requestsWaitOnSignIn ? (
        <OrcaCloudSignInLine
          className="mb-3"
          text={t('bots.cloudSignIn.accessRequests', 'Access requests need Orca sign-in.')}
          onSignedIn={refreshAccessRequests}
        />
      ) : null}
      <BotConnectorCaption
        title={t('bots.access.whoCanAsk', BOT_ACCESS_COPY.whoCanAsk, { name: bot.name })}
      />
      <BotAccessSummary bot={bot} others={listed.map((member) => member.name || member.id)} />
      <BotPeopleChips
        owner={owner}
        members={listed}
        onRemove={remove}
        add={
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                size="xs"
                variant="outline"
                disabled={service.outsiders === null || capped || saving}
                title={
                  capped
                    ? t('bots.whoCanAsk.cap', '{{count}} people is the most here.', {
                        count: cap
                      })
                    : undefined
                }
              >
                {saving ? <Loader2 className="animate-spin" /> : <Plus />}
                {t('bots.whoCanAsk.add', 'Add')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80">
              {pickerOpen ? (
                <BotWhoCanAskPicker
                  bot={bot}
                  service={service}
                  owner={owner}
                  onPicked={(picked) => void add(picked)}
                />
              ) : null}
            </PopoverContent>
          </Popover>
        }
      />
      {keptOnlyMe && listed.length === 0 && !saving ? (
        <div role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            {t('bots.whoCanAsk.keptOnlyMe', 'Removed {{names}}.', {
              names: keptOnlyMe.map((member) => member.name || member.id).join(', ')
            })}
          </span>
          {/* Giving them access back is a grant, so it asks first like any add. */}
          <Button size="xs" variant="ghost" onClick={() => void add(keptOnlyMe)}>
            <Undo2 />
            {t('bots.access.undo', BOT_ACCESS_COPY.undo)}
          </Button>
        </div>
      ) : null}
      {saving ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t('bots.whoCanAsk.saving', 'Saving…')}
        </p>
      ) : save.kind === 'failed' ? (
        <div
          role="alert"
          className="mt-2 flex items-center gap-2 rounded-md border border-destructive/40 px-2.5 py-1.5 text-xs"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 flex-1">{save.message}</span>
          <Button size="xs" variant="outline" onClick={save.retry}>
            {t('bots.whoCanAsk.retry', 'Try again')}
          </Button>
        </div>
      ) : capped && listed.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('bots.whoCanAsk.cap', '{{count}} people is the most here.', { count: cap })}
        </p>
      ) : null}
      <BotAccessDetails
        bot={bot}
        others={listed.length}
        connector={service.kind}
        onKeepOnlyMe={keepOnlyMe}
      />
      <p className="mt-2.5 text-xs text-muted-foreground">{service.outsiders ?? service.notYet}</p>
    </>
  )
}
