import React from 'react'
import { Info, Loader2, Plus, TriangleAlert, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { refreshAccessRequests, type HostAccessRequest } from '@/lib/bot-access-requests'
import type { Bot, BotMember } from '../../../../shared/bot-types'
import type { BotSlackResult } from '../../../../shared/connector-bot-slack-contract'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import { BotConnectorSection, BotPeopleChips } from './bot-connector-people'
import { BotAccessDetails, BotAccessSummary } from './BotAccessReach'
import { BotAccessWarningLine } from './BotAccessWarningLine'
import type { BotAccessConnector } from '../../../../shared/bots/bot-access-reach'
import { AttentionDot } from './AttentionDot'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import type { WhoCanAskIdentityLedger } from './who-can-ask-identity-ledger'
import { OrcaCloudSignInLine } from './orca-cloud-sign-in'
import { accessRequestPerson } from '../../../../shared/bots/bot-access-request'
import { requestLine, useBotWhoCanAsk } from './use-bot-who-can-ask'

/** complete is false when the service's people are too many to read whole. */
export type BotWhoCanAskFound = {
  /** `group`: where a service that searches its people's scope first found them: `scoped` in that
   *  scope, `outside` shown not to be in it; absent, unknown, under `peopleHeading`. */
  members: {
    id: string
    name: string
    handle?: string
    avatarUrl?: string
    /** Another Slack app's bot user, offered beside people. */
    app?: true
    group?: 'scoped' | 'outside'
    /** Muted in the real-name slot, saying why this person's source is uncertain. */
    tag?: string
  }[]
  complete: boolean
  /** What this search could not cover, shown in place of the generic incomplete line. */
  note?: string
  /** What an empty result says, when the search knows better than the service's `noMatch`. */
  empty?: { title: string; detail: string }
  /** Part of this search failed and can be asked again in place (BotWhoCanAskSession.retry). */
  retryable?: boolean
  /** Headings and tags naming where this search actually looked, over the service's defaults. */
  labels?: { scoped?: string; outsideTag?: string }
  /** Part of the search is still out, so an empty result isn't final yet. */
  pending?: true
}

/** One picker open's search. `onUpdate` keeps one listener (the picker's current query), told
 *  each time more of the search arrives (a list or a username check landing), so the picker can
 *  ask again; it returns the unsubscribe. */
export type BotWhoCanAskSession = {
  search: (query: string) => Promise<BotSlackResult<BotWhoCanAskFound>>
  onUpdate?: (listener: () => void) => () => void
  /** Forget what failed in the last search (only when the owner asks), so asking again retries. */
  retry?: () => void
}

/** One connector's people: who is listed, how to find more, and what the card says around them. */
export type BotWhoCanAskService = {
  /** The people this connector lets ask the bot; new ones are saved with `stamp`. */
  listed: (members: readonly BotMember[]) => BotMember[]
  stamp: Pick<BotMember, 'source' | 'workspaceId'>
  /** How many people this connector takes, within the bot's BOT_MAX_MEMBERS overall. */
  max: number
  search: (query: string) => Promise<BotSlackResult<BotWhoCanAskFound>>
  /** Called once per picker open (and context) for a search that keeps what it read across
   *  keystrokes; its username checks go into `ledger`, which outlives the session. */
  begin?: (ledger: WhoCanAskIdentityLedger) => BotWhoCanAskSession
  /** Shown while a username check that could change who a row or pick is is still out. */
  checkingStatus?: string
  errorMessage: (code: string) => string
  searchPlaceholder: string
  /** What a search matches people by, from what was typed (GitHub drops a leading @). */
  normalizeQuery?: (query: string) => string
  /** The picker's heading over found people, e.g. "People in Globex". */
  peopleHeading: string
  /** The heading over `scoped` people, e.g. "People in your repositories". */
  scopedHeading?: string
  /** The heading over `outside` people, kept apart so a stranger never reads as a teammate. */
  outsideHeading?: string
  /** Muted beside each `outside` person, so one alone in the results still reads as a stranger. */
  outsideTag?: string
  /** What an empty search says, naming the query and where it looked. */
  noMatch: (query: string) => { title: string; detail: string }
  /** Shown while the search box is empty and the service suggests nobody. */
  idleHint?: { title: string; detail: string }
  /** The owner's own account here, listed as the owner rather than offered; null when unknown. */
  ownerId: string | null
  /** The owner's other accounts here (GitHub's other linked logins): found as the owner, never offered. */
  otherOwnerIds?: readonly string[]
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
    <BotConnectorSection
      title={t('bots.accessRequest.heading', BOT_ACCESS_COPY.heading)}
      count={requests.length}
    >
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
    </BotConnectorSection>
  )
}

/** Who can ask the bot on one connector, as every surface shows it: the requests waiting, one summary,
 *  the people with Add, then advice and what they reach. Adding is always confirmed first. */
export function BotWhoCanAskList({
  bot,
  service,
  compactCaption
}: {
  bot: Bot
  service: BotWhoCanAskService
  /** A setup dialog's version, under this short label: chips, outsiders behind ⓘ, and one warning
   *  line once someone else is added in place of the summary and what they reach. The caller
   *  translates the label so a trust dialog can keep it from being replaced by a language pack. */
  compactCaption?: string
}): React.JSX.Element {
  const t = useTranslate()
  const compact = compactCaption !== undefined
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
  const others = listed.map((member) => member.name || member.id)
  const addPeople = (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant={compact ? 'ghost' : 'outline'}
          className={compact ? '-mr-1.5' : undefined}
          aria-label={compact ? t('bots.whoCanAsk.addPeople', 'Add people') : undefined}
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
      <PopoverContent align={compact ? 'end' : 'start'} className="w-80">
        {pickerOpen ? (
          // A draft belongs to one bot on one host: another one starts the picker afresh.
          <BotWhoCanAskPicker
            key={`${bot.hostId}\0${bot.id}`}
            bot={bot}
            service={service}
            owner={owner}
            onPicked={(picked) => void add(picked)}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
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
      {compact ? (
        <div className="flex h-5.5 items-center gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">{compactCaption}</h3>
          {service.outsiders ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={service.outsiders}
                  className="flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-72">
                {service.outsiders}
              </TooltipContent>
            </Tooltip>
          ) : null}
          <span className="ml-auto">{addPeople}</span>
        </div>
      ) : null}
      <BotConnectorSection
        title={
          compact
            ? undefined
            : t('bots.access.whoCanAsk', BOT_ACCESS_COPY.whoCanAsk, { name: bot.name })
        }
      >
        {compact ? null : <BotAccessSummary bot={bot} others={others} />}
        <BotPeopleChips
          owner={owner}
          members={listed}
          onRemove={remove}
          ownerTag={!compact}
          add={compact ? undefined : addPeople}
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
        {compact && listed.length > 0 ? <BotAccessWarningLine bot={bot} others={others} /> : null}
      </BotConnectorSection>
      {compact ? (
        service.outsiders ? null : (
          <p className="mt-2 text-xs text-muted-foreground">{service.notYet}</p>
        )
      ) : (
        <>
          <BotAccessDetails
            bot={bot}
            others={listed.length}
            connector={service.kind}
            onKeepOnlyMe={keepOnlyMe}
          />
          <p className="mt-2.5 text-xs text-muted-foreground">
            {service.outsiders ?? service.notYet}
          </p>
        </>
      )}
    </>
  )
}
