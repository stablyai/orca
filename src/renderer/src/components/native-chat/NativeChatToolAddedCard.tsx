import { useState } from 'react'
import { useCardBot } from '@/lib/bot-catalog'
import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { botToolSubtitle, botToolTitle } from '../../../../shared/bots/bot-tool-labels'
import { BotToolFinishSignIn } from '@/components/bots/BotToolFinishSignIn'
import { botToolErrorMessage, removeBotTool } from '@/components/bots/bot-tools-client'
import { useBotToolSignInAction } from '@/components/bots/bot-tool-sign-in-action'
import { useBotTools } from '@/components/bots/bot-tool-checks'
import {
  BOT_TOOL_ADDED_CARD_COPY,
  botToolAddedCardView,
  type BotToolAddedCardSay
} from '../../../../shared/bots/bot-tool-added-card-view'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatCardAvatar, NativeChatCardFrame } from './NativeChatCardFrame'
import { NativeChatMessageTimestamp } from './messages/rows/NativeChatMessageTimestamp'

type ToolAdded = NonNullable<NativeChatMessage['toolAdded']>

const COPY = BOT_TOOL_ADDED_CARD_COPY
const PIECES: Record<keyof typeof COPY, (t: Translate) => string> = {
  heading: (t) => t('components.native-chat.toolAdded.heading', COPY.heading),
  removed: (t) => t('components.native-chat.toolAdded.removed', COPY.removed),
  remove: (t) => t('components.native-chat.toolAdded.remove', COPY.remove)
}
function sayWith(t: Translate): BotToolAddedCardSay {
  return (id) => PIECES[id](t)
}

/** A tool this chat's bot gave itself: its sign-in while it needs one, and a way to remove it. */
export function NativeChatToolAddedCard({
  added,
  timestamp
}: {
  added: ToolAdded
  timestamp: number | null
}): React.JSX.Element {
  const say = sayWith(useTranslate())
  useTranslation()
  const { botId, tool } = added
  const { ref: bot } = useCardBot(botId)
  const { view } = useBotTools(bot)
  const [busy, setBusy] = useState(false)
  const own = view.status === 'ready' && 'own' in view.tools ? view.tools.own : null
  // The tool as the host has it now: the card's copy is from when it was added.
  const live = own?.find((entry) => entry.name === tool.name)
  const signIn = useBotToolSignInAction(
    bot,
    live ?? tool,
    view.status === 'ready' ? view.problems[tool.name] : undefined
  )
  const run = (action: () => Promise<void>) => {
    setBusy(true)
    void action()
      .catch((error: unknown) => toast.error(botToolErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  const { state, present } = botToolAddedCardView(
    own === null ? null : live !== undefined,
    signIn.line,
    say
  )
  return (
    <NativeChatCardFrame
      avatar={
        <NativeChatCardAvatar>
          <Wrench className="size-4 text-muted-foreground" aria-hidden />
        </NativeChatCardAvatar>
      }
      heading={say('heading')}
      trailing={
        <NativeChatMessageTimestamp timestamp={timestamp} className="text-muted-foreground" />
      }
    >
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{botToolTitle(tool.name)}</p>
          <p className="truncate text-xs text-muted-foreground">
            {[botToolSubtitle(tool), state].filter(Boolean).join(' · ')}
          </p>
        </div>
        {present ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {signIn.action ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy || signIn.action.busy}
                onClick={signIn.action.run}
              >
                {signIn.action.label}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => run(() => removeBotTool(bot, tool.name))}
            >
              {say('remove')}
            </Button>
          </div>
        ) : null}
      </div>
      {present && signIn.pasteBack ? (
        <BotToolFinishSignIn bot={bot} name={tool.name} openAgain />
      ) : null}
    </NativeChatCardFrame>
  )
}
