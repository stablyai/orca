// An Orca-typed message's post to its chat's Slack thread: the "You · Slack" tag once posted (just
// "Slack" beside another person's sender tag), a muted line while posting, Retry or Dismiss on failure.
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SlackIcon } from '@/components/icons/SlackIcon'
import { useTranslate } from '@/i18n/use-translate'
import type { SlackMirrorPost } from '../../../../../shared/connectors/external-conversation-link'
import type { OtherPersonTypist } from '../../../../../shared/agent-session/journal/agent-journal-typed-by'
import {
  slackMirrorPostedAsker,
  slackMirrorView
} from '../../../../../shared/connectors/slack-mirror-state'
import { slackMirrorPostLine } from '../../../../../shared/connectors/slack-mirror-post-line'
import { NativeChatConnectorAskerTag } from '../NativeChatConnectorAskerTag'
import { useNativeChatSlackMirrorContext } from './native-chat-slack-mirror'
import { useSlackMirrorCopy } from './NativeChatSlackMirrorItem'

/** The message's post, when the chat posts to a Slack thread and this message went (or is going). */
export function useNativeChatSlackMirrorPost(itemId: string): SlackMirrorPost | undefined {
  return useNativeChatSlackMirrorContext()?.link.mirrorPosts?.[itemId]
}

export function NativeChatSlackMirrorTag({
  typist
}: {
  /** Another person typed it (a shared teammate): their sender tag names them beside this. */
  typist?: OtherPersonTypist
}): React.JSX.Element | null {
  const mirror = useNativeChatSlackMirrorContext()
  const say = useSlackMirrorCopy()
  if (!mirror) {
    return null
  }
  return (
    <NativeChatConnectorAskerTag
      asker={slackMirrorPostedAsker(mirror.link, typist)}
      postedFrom={say(slackMirrorView(mirror.link, mirror.botName).short)}
      nameless={typist !== undefined}
    />
  )
}

export function NativeChatSlackMirrorPostLine({
  itemId,
  post
}: {
  itemId: string
  post: SlackMirrorPost | undefined
}): React.JSX.Element | null {
  const mirror = useNativeChatSlackMirrorContext()
  const t = useTranslate()
  const say = useSlackMirrorCopy()
  const line = slackMirrorPostLine(post)
  if (!line || !mirror) {
    return null
  }
  if (line.kind === 'posting') {
    return (
      <div className="flex items-center gap-1 text-2xs text-chat-foreground-faint">
        <SlackIcon className="size-3 shrink-0 opacity-60 grayscale" aria-hidden />
        <span>{say(line.copy)}</span>
      </div>
    )
  }
  return (
    <div className="flex max-w-[85%] flex-wrap items-center gap-2 text-2xs text-destructive/80">
      <span className="flex min-w-0 items-center gap-1 break-words">
        <AlertCircle className="size-3 shrink-0" aria-hidden />
        {say(line.copy)}
      </span>
      {mirror.link.mirrorBlocked ? null : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void mirror.post(itemId, 'retry')}
        >
          {t('components.native-chat.slackMirror.retry', 'Retry')}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => void mirror.post(itemId, 'dismiss')}
      >
        {t('components.native-chat.dismissDeliveryNotice', 'Dismiss')}
      </Button>
    </div>
  )
}
