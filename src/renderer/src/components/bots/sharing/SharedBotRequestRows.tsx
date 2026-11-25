// The shares offered to this account, at the top of Bots: each waits for Accept or Decline, and turns
// into the agent's own row once accepted. Nothing of it is paired before then.
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WORKTREE_CARD_SURFACE_CLASS_NAME } from '@/components/sidebar/workspace-card/surface/worktree-card-surface'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useSharedBotRequests } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatarTile } from '../BotAvatar'
import { BotShareMark } from './BotShareMark'

/** The name a request calls its owner by: their first name. */
function ownerShortName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] ?? ownerName
}

export function SharedBotRequestRow({
  request
}: {
  request: SharedBotRequestView
}): React.JSX.Element {
  const t = useTranslate()
  const [answering, setAnswering] = useState(false)
  const answer = async (accept: boolean): Promise<void> => {
    setAnswering(true)
    const args = { shareId: request.shareId }
    const done = await (
      accept ? window.api.sharedBotHosts.accept(args) : window.api.sharedBotHosts.decline(args)
    ).catch(() => false)
    if (!done) {
      setAnswering(false)
      toast.error(t('bots.share.requestFailed', 'Couldn’t answer the request. Try again.'))
    }
  }
  const sharedBy = t('bots.share.sharedBy', 'Shared by {{name}}', { name: request.ownerName })
  return (
    <div
      data-worktree-card-surface="true"
      className={cn(WORKTREE_CARD_SURFACE_CLASS_NAME, 'flex items-start pt-1.25 pb-2 pl-1.25')}
    >
      <span className="relative mr-2 shrink-0">
        <BotAvatarTile
          src={request.avatarUrl ?? null}
          fallback={botFallback({ name: request.botName, avatar: null })}
          className="size-8 rounded-md text-sm"
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="block min-w-0 truncate text-[13px] leading-5 font-normal text-foreground/80">
            {request.botName}
          </span>
          <BotShareMark line={sharedBy} />
        </div>
        <div className="truncate text-xs leading-4 text-muted-foreground">
          {t('bots.share.requestLine', '{{owner}} shared {{agent}} with you', {
            owner: ownerShortName(request.ownerName),
            agent: request.botName
          })}
        </div>
        {request.botPurpose ? (
          <div className="truncate text-xs leading-4 text-muted-foreground">
            {request.botPurpose}
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1.5">
          <Button size="xs" disabled={answering} onClick={() => void answer(true)}>
            {t('bots.share.accept', 'Accept')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={answering}
            onClick={() => void answer(false)}
          >
            {t('bots.share.decline', 'Decline')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Every request, newest first as the cloud lists them; nothing when there are none. */
export function SharedBotRequestRows(): React.JSX.Element | null {
  const requests = useSharedBotRequests()
  if (requests.length === 0) {
    return null
  }
  return (
    <div className="flex flex-col gap-px pl-1">
      {requests.map((request) => (
        <SharedBotRequestRow key={request.shareId} request={request} />
      ))}
    </div>
  )
}
