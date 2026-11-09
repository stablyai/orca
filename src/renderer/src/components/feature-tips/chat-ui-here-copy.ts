import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type ShownChatUiLaunchTipVariant = Exclude<ChatUiLaunchTipVariant, 'none'>

export function getChatUiHereVariantCopy(
  variant: ShownChatUiLaunchTipVariant,
  t: Translate = translate
): {
  paragraphs: string[]
  secondaryLabel: string | null
  primaryLabel: string
} {
  if (variant === 'chat-ui-off') {
    return {
      paragraphs: [
        t(
          'featureTips.chatUiHere.offIntro',
          'Agents can now open as a chat, with rich messages, visuals and images.'
        ),
        t(
          'featureTips.chatUiHere.offTerminal',
          'Prefer the terminal? It stays fully supported. Your agents keep opening there until you choose Chat.'
        )
      ],
      secondaryLabel: t('featureTips.chatUiHere.stayInTerminal', 'Stay in terminal'),
      primaryLabel: t('featureTips.chatUiHere.cta', 'Use Chat UI')
    }
  }
  return {
    paragraphs: [
      t(
        'featureTips.chatUiHere.onIntro',
        'Chat UI is out of Experimental and now part of Orca. Your agents keep opening as chats, with rich messages, visuals and images.'
      ),
      t(
        'featureTips.chatUiHere.onTerminal',
        'The terminal stays fully supported too. Switch any agent back anytime.'
      )
    ],
    secondaryLabel: t('featureTips.chatUiHere.switchToTerminal', 'Switch to terminal'),
    primaryLabel: t('featureTips.gotIt', 'Got it')
  }
}
