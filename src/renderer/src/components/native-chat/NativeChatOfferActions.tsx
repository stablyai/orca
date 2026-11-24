// Each card keeps its own answer; Not now still sends Dismiss to the agent.
import { useContext, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot, useCardBot } from '@/lib/bot-catalog'
import {
  answerBotOffer,
  answerBotOfferAgain,
  type BotOfferAnswerUpdate
} from '../../../../shared/bots/bot-offer-answers'
import { botErrorMessage } from '../bots/bot-presentation'
import { NativeChatCardActions } from './NativeChatCardFrame'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'

export type NativeChatOffer = {
  dismissed: boolean
  /** What the card's action was taken on, once it was: workspace ids, or import item indices. */
  sent: readonly string[] | null
  dismiss: () => void
  /** Tells the bot `text`, as if typed, and keeps `chosen` as this card's answer. */
  send: (text: string, chosen: readonly string[]) => void
  /** Like `send`, for a further action on a card already answered: replaces its answer. */
  sendAgain: (text: string, chosen: readonly string[]) => void
  /** Like `send` (`again`: `sendAgain`), told by `tell` instead of a typed message, such as a hidden
   *  card answer; `tell` resolves false when it was refused. */
  answer: (tell: () => Promise<boolean>, chosen: readonly string[], again?: boolean) => void
}

export function useNativeChatOffer(botId: string, cardId: string): NativeChatOffer {
  const t = useTranslate()
  const view = useContext(NativeChatBotKickoffContext)
  const { bot, ref } = useCardBot(botId)
  const answer = bot?.offerAnswers?.find((entry) => entry.cardId === cardId)
  // Claimed on the host before the send, so a second window, device or press sends nothing; a refused send gives
  // the claim back and leaves the card to press again.
  const answerOffer = async (
    update: Parameters<typeof answerBotOffer>[0],
    tell: () => Promise<boolean>,
    again = false
  ): Promise<void> => {
    const ops = {
      update: (offerAnswer: BotOfferAnswerUpdate) => updateBot(ref, { offerAnswer }),
      send: tell
    }
    const outcome = await (
      again && update.sent
        ? answerBotOfferAgain({ cardId, sent: update.sent }, answer?.sent, ops)
        : answerBotOffer(update, ops)
    ).catch((error: unknown) => {
      toast.error(botErrorMessage(error))
      return null
    })
    if (outcome === 'refused') {
      toast.error(
        view?.sendBlockedReason() ??
          t('components.native-chat.offerCard.notSent', "Couldn't send that to the bot. Try again.")
      )
    }
  }
  const typed = (text: string) => async (): Promise<boolean> => (await view?.send(text)) === true
  return {
    dismissed: answer?.dismissed === true,
    sent: answer?.sent?.chosen ?? null,
    dismiss: () =>
      void answerOffer(
        { cardId, dismissed: true },
        typed(t('components.native-chat.offerCard.dismiss', 'Dismiss'))
      ),
    send: (text, chosen) =>
      void answerOffer({ cardId, sent: { chosen: [...chosen] } }, typed(text)),
    sendAgain: (text, chosen) =>
      void answerOffer({ cardId, sent: { chosen: [...chosen] } }, typed(text), true),
    answer: (tell, chosen, again) =>
      void answerOffer({ cardId, sent: { chosen: [...chosen] } }, tell, again)
  }
}

/** The card's action bar: Not now until pressed, then its own action until it's done. A done card has
 *  no bar; it says so in its state. */
export function NativeChatOfferActions({
  offer,
  start,
  children
}: {
  offer: Pick<NativeChatOffer, 'dismissed' | 'dismiss'>
  /** Quiet controls on the left, such as Edit. */
  start?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <NativeChatCardActions start={start}>
      {offer.dismissed ? null : (
        <Button type="button" variant="outline" size="sm" onClick={offer.dismiss}>
          {t('components.native-chat.offerCard.notNow', 'Not now')}
        </Button>
      )}
      {children}
    </NativeChatCardActions>
  )
}
