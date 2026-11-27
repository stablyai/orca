// Each card keeps its own answer; Not now still tells the agent Dismiss. Answers go as card answers where the host takes them.
import { useContext, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotHost, updateBot, useCardBot } from '@/lib/bot-catalog'
import { callBotRpc } from '@/lib/bot-hosts'
import {
  BOTS_CONFIRMED_OFFER_ANSWER_RUNTIME_CAPABILITY,
  BOTS_OFFER_ANSWER_RUNTIME_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import {
  answerBotOffer,
  answerBotOfferAgain,
  BOT_OFFER_DISMISS_ANSWER,
  confirmBotOfferAnswer,
  type BotOfferAnswerOutcome,
  type BotOfferAnswerUpdate,
  type BotOfferSelection,
  type BotOfferTold
} from '../../../../shared/bots/bot-offer-answers'
import { isLostHostAnswer } from '@/runtime/provider-accounts/sign-in/host-sign-in-lost-answers'
import { botHostTakes } from '../bots/bot-host-capability'
import { botErrorMessage } from '../bots/bot-presentation'
import { NativeChatCardActions } from './NativeChatCardFrame'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'

export type NativeChatOffer = {
  dismissed: boolean
  pending: boolean
  /** What the card's action was taken on, once it was: workspace ids, or import item indices. */
  sent: readonly string[] | null
  dismiss: () => void
  /** Tells the bot `text` as a card answer (typed on an older host), and keeps `chosen` as this card's answer. */
  send: (text: string, chosen: readonly string[]) => void
  /** Like `send`, for a further action on a card already answered: replaces its answer. */
  sendAgain: (text: string, chosen: readonly string[]) => void
  /** Like `send` (`again`: `sendAgain`), told by `tell` instead of a typed message, such as a hidden
   *  card answer; `tell` resolves false when it was refused. */
  answer: (tell: () => Promise<boolean>, chosen: readonly string[], again?: boolean) => void
  /** A host that saves the card after admitting its answer can confirm it in one request. */
  confirm: (tell: () => Promise<BotOfferTold>) => void
}

export function useNativeChatOffer(botId: string, cardId: string): NativeChatOffer {
  const t = useTranslate()
  const view = useContext(NativeChatBotKickoffContext)
  const { bot, ref } = useCardBot(botId)
  const answer = bot?.offerAnswers?.find((entry) => entry.cardId === cardId)
  const [pending, setPending] = useState(false)
  const running = useRef(0)
  const run = async (
    submit: () => Promise<BotOfferAnswerOutcome>,
    hostSerializes = false
  ): Promise<void> => {
    if (running.current > 0 && !hostSerializes) {
      return
    }
    running.current += 1
    setPending(true)
    try {
      if ((await submit()) === 'refused') {
        toast.error(
          view?.sendBlockedReason() ??
            t(
              'components.native-chat.offerCard.notSent',
              "Couldn't send that to the bot. Try again."
            )
        )
      }
    } catch (error) {
      toast.error(botErrorMessage(error))
    } finally {
      running.current -= 1
      setPending(running.current > 0)
    }
  }
  const confirm = (tell: () => Promise<BotOfferTold>): void => {
    void run(async () => {
      try {
        return (await confirmBotOfferAnswer(tell)).sent ? 'sent' : 'refused'
      } finally {
        await refreshBotHost(ref.hostId)
      }
    }, true)
  }
  // Claimed on the host before the send, so a second window, device or press sends nothing; a refused send gives
  // the claim back and leaves the card to press again.
  const answerOffer = (
    update: Parameters<typeof answerBotOffer>[0],
    tell: () => Promise<boolean>,
    again = false
  ): void => {
    const ops = {
      update: (offerAnswer: BotOfferAnswerUpdate) => updateBot(ref, { offerAnswer }),
      send: tell,
      deliveryUnknown: isLostHostAnswer
    }
    void run(() =>
      again && update.sent
        ? answerBotOfferAgain({ cardId, sent: update.sent }, answer?.sent, ops)
        : answerBotOffer(update, ops)
    )
  }
  const typed = (text: string) => async (): Promise<boolean> => (await view?.send(text)) === true
  // Typed follows the follow-up setting and can steer a running turn; a card answer always waits for it.
  const sessionId = view?.sessionId
  const asCardAnswer = !!sessionId && botHostTakes(ref, BOTS_OFFER_ANSWER_RUNTIME_CAPABILITY)
  const hostConfirms =
    !!sessionId && botHostTakes(ref, BOTS_CONFIRMED_OFFER_ANSWER_RUNTIME_CAPABILITY)
  const sendAnswer = (selection: BotOfferSelection, text: string, again = false): void => {
    if (hostConfirms && !again) {
      confirm(() =>
        callBotRpc<BotOfferTold>(ref, 'bots.offer.answer', {
          botId,
          sessionId,
          text,
          answer: selection
        })
      )
      return
    }
    const tell = asCardAnswer
      ? async () =>
          (await callBotRpc<BotOfferTold>(ref, 'bots.offer.answer', { botId, sessionId, text }))
            .sent
      : typed(text)
    answerOffer(selection, tell, again)
  }
  return {
    dismissed: answer?.dismissed === true,
    pending,
    sent: answer?.sent?.chosen ?? null,
    dismiss: () =>
      sendAnswer(
        { cardId, dismissed: true },
        asCardAnswer
          ? BOT_OFFER_DISMISS_ANSWER
          : t('components.native-chat.offerCard.dismiss', 'Dismiss')
      ),
    send: (text, chosen) => sendAnswer({ cardId, sent: { chosen: [...chosen] } }, text),
    sendAgain: (text, chosen) => sendAnswer({ cardId, sent: { chosen: [...chosen] } }, text, true),
    answer: (tell, chosen, again) =>
      answerOffer({ cardId, sent: { chosen: [...chosen] } }, tell, again),
    confirm
  }
}

/** The card's action bar: Not now until pressed, then its own action until it's done. A done card has
 *  no bar; it says so in its state. */
export function NativeChatOfferActions({
  offer,
  start,
  children
}: {
  offer: Pick<NativeChatOffer, 'dismissed' | 'dismiss' | 'pending'>
  /** Quiet controls on the left, such as Edit. */
  start?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <fieldset className="min-w-0" disabled={offer.pending} aria-busy={offer.pending}>
      <NativeChatCardActions start={start}>
        {offer.dismissed ? null : (
          <Button type="button" variant="outline" size="sm" onClick={offer.dismiss}>
            {t('components.native-chat.offerCard.notNow', 'Not now')}
          </Button>
        )}
        {children}
      </NativeChatCardActions>
    </fieldset>
  )
}
