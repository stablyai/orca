// A share request's own page, opened from its row: who shared which agent, and Accept or Decline.
import { useEffect } from 'react'
import { Laptop, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useSharedBotRequests } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { useMobilePageEscape } from '@/components/mobile/use-mobile-page-escape'
import { BotAvatarTile } from '../BotAvatar'
import { useSharedBotRequestAnswer } from './use-shared-bot-request-answer'
import { ownerShortName } from './SharedBotRequestRows'

export function SharedBotRequestPage({
  request
}: {
  request: SharedBotRequestView
}): React.JSX.Element {
  const t = useTranslate()
  const { answering, answer } = useSharedBotRequestAnswer(request.shareId)
  useMobilePageEscape(useAppStore((s) => s.closeShareRequestPage))
  return (
    <div
      data-shared-bot-request-page={request.shareId}
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto scrollbar-sleek bg-background p-6"
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

/** The shareRequest view: the open request's page while it is still offered. */
export function SharedBotRequestPageMount(): React.JSX.Element | null {
  const shareId = useAppStore((s) => s.shareRequestId)
  const close = useAppStore((s) => s.closeShareRequestPage)
  const request = useSharedBotRequests().find((candidate) => candidate.shareId === shareId)
  useEffect(() => {
    // Answered here or elsewhere, or no longer offered: back to where it was opened from.
    if (!request) {
      close()
    }
  }, [close, request])
  return request ? <SharedBotRequestPage request={request} /> : null
}
