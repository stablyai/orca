import { Link2 } from 'lucide-react'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { SessionLinkSnapshot } from '../../../../shared/session-link'
import {
  sessionLinkOwnerRequest,
  sessionLinkWaitingFor
} from '../../../../shared/session-link-wait'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { sessionLinkPauseReason } from './session-link-presentation'
import './session-link-trigger.css'

export function SessionLinkTrigger({
  snapshot,
  sessionId,
  onOpen
}: {
  snapshot: SessionLinkSnapshot | null
  sessionId: string
  onOpen: () => void
}): React.JSX.Element {
  const t = useTranslate()

  const link = snapshot?.link
  const partner = link?.participants.find((p) => p.sessionId !== sessionId)
  const question = link?.state === 'paused' && snapshot && sessionLinkOwnerRequest(snapshot.events)
  const waiting =
    link?.state === 'active' &&
    snapshot &&
    link.participants.some((p) => sessionLinkWaitingFor(snapshot.events, p.sessionId))
  const status =
    link?.state === 'paused'
      ? question
        ? t('components.sessionLink.ownerQuestion', 'Question for you')
        : sessionLinkPauseReason(link, t)
      : link?.state === 'ended'
        ? t('components.sessionLink.endedShort', 'Ended')
        : waiting
          ? t('components.sessionLink.waitingShort', 'Waiting')
          : null
  const label =
    link && link.participants.length > 2
      ? t('components.sessionLink.linkedGroup', 'Linked agents: {{agents}}', {
          agents: link.participants
            .filter((p) => p.sessionId !== sessionId)
            .map((p) => tuiAgentDisplayName(p.agent) ?? p.agent)
            .join(', ')
        }) + (status ? ` · ${status}` : '')
      : partner
        ? t('components.sessionLink.linkedAgent', 'Linked with {{agent}} ({{role}})', {
            agent: tuiAgentDisplayName(partner.agent) ?? partner.agent,
            role:
              partner.role === 'reviewer'
                ? t('components.sessionLink.roleReviewer', 'reviewer')
                : t('components.sessionLink.roleImplementer', 'implementer')
          }) + (status ? ` · ${status}` : '')
        : t('components.sessionLink.title', 'Work together')
  const dot = question
    ? 'bg-status-warning-text'
    : link?.state === 'paused'
      ? 'border border-muted-foreground bg-background'
      : waiting
        ? 'bg-muted-foreground'
        : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          data-session-link-active={link && link.state !== 'ended' ? '' : undefined}
          onClick={onOpen}
        >
          <Link2 className="size-3" aria-hidden />
          {dot ? (
            <span aria-hidden className={`absolute right-0 top-0.5 size-1.5 rounded-full ${dot}`} />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
