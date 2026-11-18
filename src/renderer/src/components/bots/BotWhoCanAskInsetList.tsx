// Who can ask, as one list of real people: requests waiting first (their actions under the full
// name), the owner, the people added (✕ on hover), and Add people last.
import React from 'react'
import { Loader2, Plus, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { botMemberSource, type Bot, type BotMember } from '../../../../shared/bot-types'
import { BOT_ACCESS_COPY } from '../../../../shared/bots/bot-access-copy'
import { accessRequestPerson } from '../../../../shared/bots/bot-access-request'
import { AttentionDot } from './AttentionDot'
import { BotConnectorCaption, BotMemberAvatar, BotOwnerAvatar } from './bot-connector-people'
import { BotAccessControlLine } from './BotAccessReach'
import type { BotWhoCanAskService } from './BotWhoCanAskList'
import { requestLine, useBotWhoCanAsk } from './use-bot-who-can-ask'
import { BotWhoCanAskPicker } from './BotWhoCanAskPicker'
import { OrcaCloudSignInLine } from './orca-cloud-sign-in'
import { refreshAccessRequests } from '@/lib/bot-access-requests'
import { SettingsInsetGroup } from './settings-view/BotSettingsRows'

const ROW = 'flex min-h-11 w-full min-w-0 items-center gap-2.5 py-2 pr-2.5 pl-3 text-[13px]'

const memberName = (member: BotMember): string => member.name || member.id

export function BotWhoCanAskInsetList({
  bot,
  service
}: {
  bot: Bot
  service: BotWhoCanAskService
}): React.JSX.Element {
  const t = useTranslate()
  const list = useBotWhoCanAsk(bot, service)
  const { listed, requests, saving, save, capped, cap } = list
  const addDisabled = service.outsiders === null || capped || saving
  return (
    <>
      <BotConnectorCaption title={t('bots.whoCanAsk.caption', 'Who can ask')} />
      {list.requestsWaitOnSignIn ? (
        <OrcaCloudSignInLine
          className="mb-2"
          text={t('bots.cloudSignIn.accessRequests', 'Access requests need Orca sign-in.')}
          onSignedIn={refreshAccessRequests}
        />
      ) : null}
      <SettingsInsetGroup>
        {requests.map((request) => {
          const { id, avatarUrl } = request.requester
          const person = accessRequestPerson(request)
          return (
            <div key={request.requestId} className={cn(ROW, 'items-start')}>
              <AttentionDot />
              <span className="mt-px size-5.5 shrink-0">
                <BotMemberAvatar
                  member={{ id, name: person, ...(avatarUrl ? { avatarUrl } : {}) }}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-[18px] break-words">{person}</span>
                <span className="block text-xs leading-4 break-words text-muted-foreground">
                  {requestLine(request)}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => list.review(request)}>
                    {t('bots.accessRequest.reviewButton', BOT_ACCESS_COPY.review)}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => list.decline(request)}>
                    {t('bots.accessRequest.decline', BOT_ACCESS_COPY.decline)}
                  </Button>
                </span>
              </span>
            </div>
          )
        })}
        <div className={ROW}>
          <span className="size-5.5 shrink-0">
            <BotOwnerAvatar />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{list.owner}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {t('bots.whoCanAsk.owner', 'Owner')}
          </span>
        </div>
        {listed.map((member) => (
          <div key={`${botMemberSource(member)}:${member.id}`} className={cn(ROW, 'group/person')}>
            <span className="size-5.5 shrink-0">
              <BotMemberAvatar member={member} />
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{memberName(member)}</span>
            {/* Shown on hover or focus, so the row never changes width. */}
            <span className="shrink-0 opacity-0 group-hover/person:opacity-100 focus-within:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('bots.whoCanAsk.removePerson', 'Remove {{name}}', {
                  name: memberName(member)
                })}
                onClick={() => list.remove(member)}
              >
                <X />
              </Button>
            </span>
          </div>
        ))}
        <Popover open={list.pickerOpen} onOpenChange={list.setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={addDisabled}
              title={
                capped
                  ? t('bots.whoCanAsk.cap', '{{count}} people is the most here.', { count: cap })
                  : undefined
              }
              className={cn(
                ROW,
                'text-left text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 disabled:pointer-events-none disabled:opacity-50'
              )}
            >
              <span className="flex size-5.5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50">
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {t('bots.whoCanAsk.addPeople', 'Add people')}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80">
            {list.pickerOpen ? (
              <BotWhoCanAskPicker
                bot={bot}
                service={service}
                owner={list.owner}
                onPicked={(picked) => void list.add(picked)}
              />
            ) : null}
          </PopoverContent>
        </Popover>
      </SettingsInsetGroup>
      {save.kind === 'failed' ? (
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
      ) : null}
      <BotAccessControlLine
        bot={bot}
        others={listed.map(memberName)}
        className="mt-1.5 px-3 text-xs leading-[17px] text-muted-foreground"
      />
    </>
  )
}
