import type { ComponentType } from 'react'
import { ConnectorAvatar } from '@/components/ConnectorAvatar'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { openOwnedHttpLink } from '@/lib/browser/navigation/http-link-routing'
import { DiscordIcon } from '../icons/DiscordIcon'
import { GitHubIcon } from '../icons/GitHubIcon'
import { LinearIcon } from '../icons/LinearIcon'
import { SlackIcon } from '../icons/SlackIcon'
import { connectorAskerTagView } from '../../../../shared/connectors/connector-message-asker-view'
import type { ConnectorMessageAsker } from '../../../../shared/connector-message-asker'

export const CONNECTOR_SOURCE_ICONS: Partial<
  Record<ConnectorMessageAsker['source'], ComponentType<{ className?: string }>>
> = { slack: SlackIcon, github: GitHubIcon, linear: LinearIcon, discord: DiscordIcon }

/** "Sam Lee · Slack" over a message Orca delivered from a connector; opens where it was written. */
export function NativeChatConnectorAskerTag({
  asker,
  postedFrom,
  nameless = false
}: {
  asker: ConnectorMessageAsker
  /** Typed in Orca and posted to this place ("#eng thread"), which the tooltip says. */
  postedFrom?: string
  /** Only the place: a sender tag beside it already names who typed it. */
  nameless?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const view = connectorAskerTagView(asker, t)
  const { own, name, place, open } = view
  const label = postedFrom
    ? t('components.native-chat.slackMirror.postedFrom', 'Posted to {{place}} from Orca', {
        place: postedFrom
      })
    : view.label
  const SourceIcon = CONNECTOR_SOURCE_ICONS[asker.source]
  const content = (
    <>
      {own || nameless ? null : (
        <ConnectorAvatar avatarUrl={asker.avatarUrl} name={name} className="-ml-1.5 size-4" />
      )}
      {nameless ? null : (
        <>
          <span className="min-w-0 truncate font-medium text-chat-foreground">{name}</span>
          <span aria-hidden>·</span>
        </>
      )}
      {SourceIcon ? <SourceIcon className="size-3 shrink-0" /> : null}
      <span className="min-w-0 truncate">{place}</span>
    </>
  )
  if (!open) {
    return (
      <Badge variant="chatSender" title={label}>
        {content}
      </Badge>
    )
  }
  return (
    <Badge asChild variant="chatSender">
      <button
        type="button"
        title={`${label} · ${open.label}`}
        aria-label={`${label}. ${open.label}`}
        // A source's own page, opened on this computer whichever host runs the chat.
        onClick={() =>
          openOwnedHttpLink(open.url, { sourceOwner: { kind: 'local' }, forceSystemBrowser: true })
        }
      >
        {content}
      </button>
    </Badge>
  )
}
