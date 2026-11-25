// A share request's own page, opened from its row: who shared which agent, and Accept or Decline.
import { useEffect, useRef } from 'react'
import { Laptop, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useSharedBotRequests } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { useMobilePageEscape } from '@/components/mobile/use-mobile-page-escape'
import { BotAvatarTile } from '../BotAvatar'
import { closeSharedBotRequest, useOpenSharedBotRequest } from './shared-bot-request-open'
import { useSharedBotRequestAnswer } from './use-shared-bot-request-answer'
import { ownerShortName } from './SharedBotRequestRows'

export function SharedBotRequestPage({
  request
}: {
  request: SharedBotRequestView
}): React.JSX.Element {
  const t = useTranslate()
  const { answering, answer } = useSharedBotRequestAnswer(request.shareId)
  useMobilePageEscape(closeSharedBotRequest)
  return (
    <div
      data-shared-bot-request-page={request.shareId}
      className="absolute inset-0 z-[5] flex items-center justify-center overflow-auto scrollbar-sleek bg-background p-6"
    >
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <BotAvatarTile
          src={request.avatarUrl ?? null}
          fallback={botFallback({ name: request.botName, avatar: null })}
          className="size-20 rounded-2xl text-3xl"
        />
        <h1 className="mt-4 text-xl font-semibold text-foreground">
          {t('bots.share.requestPageTitle', '{{owner}} shared {{agent}} with you', {
            owner: request.ownerName,
            agent: request.botName
          })}
        </h1>
        {request.botPurpose ? (
          <p className="mt-1 line-clamp-3 text-sm text-muted-foreground">{request.botPurpose}</p>
        ) : null}
        <div className="mt-5 flex w-full flex-col gap-2.5 rounded-lg border border-border px-4 py-3 text-left text-sm">
          <div className="flex min-w-0 items-center gap-2.5">
            <User className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{request.ownerName}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2.5">
            <Laptop className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {t('bots.share.requestRunsOn', 'Runs on {{owner}}’s computer', {
                owner: ownerShortName(request.ownerName)
              })}
            </span>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <Button
            size="lg"
            variant="outline"
            disabled={answering}
            onClick={() => void answer(false)}
          >
            {t('bots.share.decline', 'Decline')}
          </Button>
          <Button size="lg" disabled={answering} onClick={() => void answer(true)}>
            {t('bots.share.accept', 'Accept')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The open request's page while it is still offered and the main column hasn't moved on. */
export function SharedBotRequestPageMount(): React.JSX.Element | null {
  const shareId = useOpenSharedBotRequest()
  const request = useSharedBotRequests().find((candidate) => candidate.shareId === shareId)
  const place = useAppStore((s) => `${s.activeView}\0${s.activeWorktreeId ?? ''}`)
  const pinned = useRef<{ shareId: string; place: string } | null>(null)
  useEffect(() => {
    if (shareId === null) {
      pinned.current = null
    } else if (pinned.current?.shareId !== shareId) {
      // Opening pins the page to where the main column was; any move from there closes it.
      pinned.current = { shareId, place }
    } else if (pinned.current.place !== place) {
      closeSharedBotRequest()
    }
  }, [place, shareId])
  useEffect(() => {
    if (shareId !== null && !request) {
      closeSharedBotRequest()
    }
  }, [request, shareId])
  return request ? <SharedBotRequestPage request={request} /> : null
}
