import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { BotGroupMessage } from '../../../../shared/bots/bot-group'
import { botGroupPeerLine } from '../../../../shared/bots/bot-group-peer-line'

/** A bot-to-bot hand-off: who asked whom, or whose reply the asker read, between the owner's messages. */
export function BotGroupPeerRequestLine({
  message
}: {
  message: BotGroupMessage
}): React.JSX.Element {
  const t = useTranslate()
  useUiLanguageRevision()
  const line = botGroupPeerLine(message)
  return (
    <p data-group-peer-request className="text-center text-xs text-chat-foreground-faint">
      {line.kind === 'asked'
        ? t('bots.groups.peerAsked', '{{from}} asked {{to}}', line)
        : line.kind === 'told'
          ? t('bots.groups.peerTold', '{{from}} told {{to}}', line)
          : line.kind === 'read'
            ? t('bots.groups.peerReplyRead', "{{reader}} read {{peer}}'s reply", line)
            : line.kind === 'items'
              ? t('bots.groups.peerReadItems', '{{bot}} read an update to its items', line)
              : line.kind === 'paused'
                ? t(
                    'bots.groups.handoffsPaused',
                    'Paused after {{count}} hand-offs. Reply to continue.',
                    line
                  )
                : t('bots.groups.peerFollowedUp', '{{bot}} followed up', line)}
    </p>
  )
}
