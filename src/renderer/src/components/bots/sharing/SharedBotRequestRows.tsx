// The shares offered to this account, at the top of Bots: each is the agent's row as it will be once
// accepted, dimmed, with an invite mark on its picture. Its dialog explains it and answers it; nothing
// of it is paired before then.
import { useState } from 'react'
import { Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WORKTREE_CARD_SURFACE_CLASS_NAME } from '@/components/sidebar/workspace-card/surface/worktree-card-surface'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useSharedBotRequests } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import { BotOwnerAvatar } from '../bot-connector-people'
import { BotShareMark } from './BotShareMark'
import { SharedBotInviteDialog, SharedBotRequestAvatar } from './SharedBotInviteDialog'

// The status badges' cutout (bot-avatar-status-badge.tsx), so the mark sits where they do.
const INVITE_MARK_CUTOUT: React.CSSProperties = {
  maskImage:
    'radial-gradient(circle at calc(100% - 3px) calc(100% - 3px), transparent 8px, #000 8.5px)'
}

export function SharedBotRequestRow({
  request
}: {
  request: SharedBotRequestView
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const invited = t('bots.share.invite.invitedYou', '{{owner}} invited you', {
    owner: request.ownerName
  })
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`${request.botName}, ${invited}`}
        data-worktree-card-surface="true"
        data-worktree-card-active={open ? 'primary' : undefined}
        className={cn(
          WORKTREE_CARD_SURFACE_CLASS_NAME,
          'flex items-center pt-1.25 pb-1.25 pl-1.25 focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
          !open && 'worktree-sidebar-card-hover'
        )}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === 'Enter' || event.key === ' ')
          ) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="relative mr-2 shrink-0">
          <span className="flex opacity-60" style={INVITE_MARK_CUTOUT}>
            <SharedBotRequestAvatar request={request} className="size-8 rounded-md text-sm" />
          </span>
          <span className="absolute right-[3px] bottom-[3px] flex size-0 items-center justify-center">
            <Mail className="size-3 shrink-0 text-foreground" aria-hidden />
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex min-w-0 items-center gap-1.5 opacity-60">
            <span className="block min-w-0 truncate text-[13px] leading-5 text-foreground/80">
              {request.botName}
            </span>
            <BotShareMark
              line={t('bots.share.sharedBy', 'Shared by {{name}}', { name: request.ownerName })}
            />
          </div>
          <div className="flex min-w-0 items-center gap-1 text-xs leading-4 text-muted-foreground">
            <span className="size-3.5 shrink-0">
              <BotOwnerAvatar iconClassName="size-2.5" />
            </span>
            <span className="truncate">{invited}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="xs"
          tabIndex={-1}
          className="shrink-0 px-1 text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
        >
          {t('bots.share.invite.view', 'View invite')}
        </Button>
      </div>
      <SharedBotInviteDialog request={request} open={open} onOpenChange={setOpen} />
    </>
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
