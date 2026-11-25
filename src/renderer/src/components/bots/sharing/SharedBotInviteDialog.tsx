// What accepting an agent shared with this account means, in plain lines, with Accept and Decline: the
// only place a share is answered on this computer.
import { Eye, KeyRound, Laptop, Lock, LogOut, MessageSquare, Moon, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import type { SharedBotRequestView } from '../../../../../shared/bots/shared-bot-hosts'
import type { AgentCardService } from '../../../../../shared/bots/agent-card-contract'
import { agentCardAvatar, agentCardServices } from '../../../../../shared/bots/shared-agent-card'
import { GitHubIcon } from '../../icons/GitHubIcon'
import { GoogleIcon } from '../../icons/GoogleIcon'
import { LinearIcon } from '../../icons/LinearIcon'
import { SlackIcon } from '../../icons/SlackIcon'
import { BotAvatar } from '../BotAvatar'
import { ownerShortName } from '../../../../../shared/bots/shared-bot-owner-name'
import { useSharedBotRequestAnswer } from './use-shared-bot-request-answer'

const SERVICES: Record<AgentCardService, { name: string; Icon: typeof GitHubIcon }> = {
  github: { name: 'GitHub', Icon: GitHubIcon },
  slack: { name: 'Slack', Icon: SlackIcon },
  linear: { name: 'Linear', Icon: LinearIcon },
  google: { name: 'Google', Icon: GoogleIcon }
}

/** The request's agent as its card draws it: its mascot, else its initial. */
export function SharedBotRequestAvatar({
  request,
  className,
  size
}: {
  request: SharedBotRequestView
  className?: string
  size?: 'large'
}): React.JSX.Element {
  return (
    <BotAvatar
      bot={{
        id: request.botId,
        name: request.botName,
        hostId: LOCAL_EXECUTION_HOST_ID,
        ...agentCardAvatar(request.agentCard)
      }}
      size={size}
      className={className}
    />
  )
}

function Fact({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 px-3 py-1.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

export function SharedBotInviteDialog({
  request,
  open,
  onOpenChange
}: {
  request: SharedBotRequestView
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { answering, answer } = useSharedBotRequestAnswer(request.shareId)
  const owner = ownerShortName(request.ownerName)
  const services = agentCardServices(request.agentCard)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="form" busy={answering} aria-describedby={undefined}>
        <DialogHeader>
          <div className="flex items-center gap-3.5">
            <SharedBotRequestAvatar
              request={request}
              size="large"
              className="size-14 rounded-xl text-2xl"
            />
            <div className="min-w-0">
              <DialogTitle>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{request.botName}</span>
                  <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </span>
              </DialogTitle>
              <DialogDescription>
                {t('bots.share.invite.sharedWithYou', '{{owner}} shared it with you', {
                  owner: request.ownerName
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {request.botPurpose ? (
          <p className="line-clamp-4 text-sm text-foreground/90">{request.botPurpose}</p>
        ) : null}
        <ul className="rounded-lg border border-border py-1 text-sm dark:bg-foreground/[0.02]">
          <Fact icon={Laptop}>
            {t('bots.share.invite.runsOn', '{{owner}}’s agent. It runs on {{owner}}’s computer.', {
              owner
            })}
          </Fact>
          <Fact icon={MessageSquare}>
            {t('bots.share.invite.chatFrom', 'You chat with it from your Orca and your phone.')}
          </Fact>
          <Fact icon={Lock}>{t('bots.share.invite.ownChats', 'You see only your own chats.')}</Fact>
          <Fact icon={Eye}>
            {t('bots.share.invite.ownerSees', '{{owner}} can see your chats with it.', { owner })}
          </Fact>
          <Fact icon={KeyRound}>
            {t(
              'bots.share.invite.actsAs',
              'It can act on {{owner}}’s computer, with {{owner}}’s accounts.',
              { owner }
            )}
          </Fact>
          <Fact icon={Moon}>
            {t('bots.share.invite.pauses', 'It pauses while {{owner}}’s computer is off.', {
              owner
            })}{' '}
            <span className="text-muted-foreground">
              {t('bots.share.invite.messagesWait', 'Messages wait until it’s back.')}
            </span>
          </Fact>
          <Fact icon={LogOut}>{t('bots.share.invite.leave', 'You can leave anytime.')}</Fact>
        </ul>
        {services.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {t('bots.share.invite.uses', 'Uses')}
            {services.map((service) => {
              const { name, Icon } = SERVICES[service]
              return (
                <span
                  key={service}
                  className="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border px-2 text-foreground dark:border-input"
                >
                  <Icon className="size-3" />
                  {name}
                </span>
              )
            })}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={answering}
            onClick={() => void answer(false)}
          >
            {t('bots.share.decline', 'Decline')}
          </Button>
          <Button size="sm" disabled={answering} onClick={() => void answer(true)}>
            {t('bots.share.accept', 'Accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
