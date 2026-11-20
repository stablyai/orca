import { useState } from 'react'
import { useCardBot } from '@/lib/bot-catalog'
import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import { NativeChatEventRow } from './messages/events/NativeChatEventRow'

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

/** A tool this chat's bot gave itself, as a status row: its sign-in while it needs one, and Remove. */
export function NativeChatToolAddedCard({
  added,
  timestamp
}: {
  added: ToolAdded
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const say = sayWith(t)
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
  const title = botToolTitle(tool.name)
  const removed = own !== null && !present
  const lead = removed ? say('removed') : t('components.native-chat.toolAdded.added', 'Added')
  const after = removed ? [] : [botToolSubtitle(tool), state].filter(Boolean)
  const actionClass =
    'rounded-sm text-xs font-medium text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
  return (
    <div>
      <NativeChatEventRow
        icon={<Wrench aria-hidden className="size-3.5" />}
        timestamp={timestamp}
        action={
          present ? (
            <span className="flex items-center gap-2">
              {signIn.action ? (
                <button
                  type="button"
                  className={actionClass}
                  disabled={busy || signIn.action.busy}
                  onClick={signIn.action.run}
                >
                  {signIn.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className={actionClass}
                disabled={busy}
                onClick={() => run(() => removeBotTool(bot, tool.name))}
              >
                {say('remove')}
              </button>
            </span>
          ) : null
        }
      >
        {lead} <span className="text-chat-foreground">{title}</span>
        {after.map((part) => ` · ${part}`).join('')}
      </NativeChatEventRow>
      {present && signIn.pasteBack ? (
        <div className="ml-5">
          <BotToolFinishSignIn bot={bot} name={tool.name} openAgain />
        </div>
      ) : null}
    </div>
  )
}
