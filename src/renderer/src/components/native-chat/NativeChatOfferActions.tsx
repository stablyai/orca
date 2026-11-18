// Every offer card a bot shows answers one way: its action stays until it's done, and Dismiss hides only once
// the owner presses it. Each card's answer is its own, kept on the bot by card, so no card answers another.
import { useContext, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { updateBot, useCardBot } from '@/lib/bot-catalog'
import { answerBotOffer } from '../../../../shared/bots/bot-offer-answers'
import { botErrorMessage } from '../bots/bot-presentation'
import { NativeChatBotKickoffContext } from './native-chat-bot-kickoff-view'

export type NativeChatOffer = {
  dismissed: boolean
  /** What the card's action was taken on, once it was: workspace ids, or import item indices. */
  sent: readonly string[] | null
  dismiss: () => void
  /** Tells the bot `text`, as if typed, and keeps `chosen` as this card's answer. */
  send: (text: string, chosen: readonly string[]) => void
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
    text: string
  ): Promise<void> => {
    const outcome = await answerBotOffer(update, {
      update: (offerAnswer) => updateBot(ref, { offerAnswer }),
      send: async () => (await view?.send(text)) === true
    }).catch((error: unknown) => {
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
  return {
    dismissed: answer?.dismissed === true,
    sent: answer?.sent?.chosen ?? null,
    dismiss: () =>
      void answerOffer(
        { cardId, dismissed: true },
        t('components.native-chat.offerCard.dismiss', 'Dismiss')
      ),
    send: (text, chosen) => void answerOffer({ cardId, sent: { chosen: [...chosen] } }, text)
  }
}

/** The card's buttons: Dismiss until pressed, then its own action until it's done. */
export function NativeChatOfferActions({
  offer,
  done,
  doneLabel,
  children
}: {
  offer: Pick<NativeChatOffer, 'dismissed' | 'dismiss'>
  done: boolean
  /** In place of the buttons once done; absent where the card says so itself. */
  doneLabel?: string
  children: ReactNode
}): React.JSX.Element | null {
  const t = useTranslate()
  if (done) {
    return doneLabel ? (
      <p className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3" aria-hidden />
        {doneLabel}
      </p>
    ) : null
  }
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {offer.dismissed ? null : (
        <Button type="button" variant="ghost" size="xs" onClick={offer.dismiss}>
          {t('components.native-chat.offerCard.dismiss', 'Dismiss')}
        </Button>
      )}
      {children}
    </div>
  )
}
