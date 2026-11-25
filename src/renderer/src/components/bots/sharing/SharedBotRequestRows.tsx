// The shares offered to this account, at the top of Bots: each waits for Accept or Decline, and turns
// into the agent's own row once accepted. Nothing of it is paired before then.
import { Button } from '@/components/ui/button'
import { WORKTREE_CARD_SURFACE_CLASS_NAME } from '@/components/sidebar/workspace-card/surface/worktree-card-surface'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useSharedBotRequests } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { botFallback } from '../../../../../shared/bots/bot-avatar-fallback'
import { BotAvatarTile } from '../BotAvatar'
import { BotShareMark } from './BotShareMark'
import { openSharedBotRequest, useOpenSharedBotRequest } from './shared-bot-request-open'
import { useSharedBotRequestAnswer } from './use-shared-bot-request-answer'

/** The name a request calls its owner by: their first name. */
export function ownerShortName(ownerName: string): string {
  return ownerName.trim().split(/\s+/)[0] ?? ownerName
}

export function SharedBotRequestRow({
  request
}: {
  request: SharedBotRequestView
}): React.JSX.Element {
  const t = useTranslate()
  const { answering, answer } = useSharedBotRequestAnswer(request.shareId)
  const open = useOpenSharedBotRequest() === request.shareId
  const sharedBy = t('bots.share.sharedBy', 'Shared by {{name}}', { name: request.ownerName })
  return (
    <div
      role="button"
      tabIndex={0}
      data-worktree-card-surface="true"
      data-worktree-card-active={open ? 'primary' : undefined}
      className={cn(
        WORKTREE_CARD_SURFACE_CLASS_NAME,
        'flex items-start pt-1.25 pb-2 pl-1.25',
        !open && 'worktree-sidebar-card-hover'
      )}
      onClick={() => openSharedBotRequest(request.shareId)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          openSharedBotRequest(request.shareId)
        }
      }}
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
        {/* Answering in place leaves the page closed; the buttons are not the row's click. */}
        <div
          className="mt-2 flex items-center gap-1.5"
          onClick={(event) => event.stopPropagation()}
        >
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
