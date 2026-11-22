import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatComposerTabStrip } from '../native-chat/composer/controls/NativeChatComposerTabStrip'
import { botChatAutoCloseStripText } from './bot-chat-auto-close-copy'
import { useBotChatAutoClose } from './use-bot-chat-auto-close'
import { useBotForWorkspace } from './bot-workspace'

type StripAction = { label: string; onClick: () => void }

/** A one-line strip over the composer: the chat closing, paused or kept open, and what to do about it.
 *  Its line announces politely, and only changes on a new phase or minute. */
export function BotChatAutoCloseStripView({
  text,
  actions
}: {
  text: string
  actions: readonly StripAction[]
}): React.JSX.Element {
  return (
    <NativeChatComposerTabStrip data-bot-chat-auto-close="">
      <p role="status" aria-live="polite" className="min-w-0 flex-1 py-1 tabular-nums">
        {text}
      </p>
      {actions.map((action) => (
        <Button
          key={action.label}
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </NativeChatComposerTabStrip>
  )
}

/** A bot side chat whose items are all done or canceled: its countdown, Keep open and Close now. */
export function BotChatAutoCloseComposerStrip({
  worktreeId,
  sessionId,
  isVisible
}: {
  worktreeId: string | undefined
  sessionId: string
  isVisible: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const bot = useBotForWorkspace(worktreeId ?? null)
  const { view, now, keepOpen, closeNow } = useBotChatAutoClose(bot, sessionId, isVisible)
  if (!view) {
    return null
  }
  const close = { label: t('bots.chats.autoClose.closeNow', 'Close now'), onClick: closeNow }
  const keep = { label: t('bots.chats.autoClose.keepOpen', 'Keep open'), onClick: keepOpen }
  return (
    <BotChatAutoCloseStripView
      text={botChatAutoCloseStripText(t, view, now)}
      actions={view.phase === 'kept' ? [close] : [keep, close]}
    />
  )
}
