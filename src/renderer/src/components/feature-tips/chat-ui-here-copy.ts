import type { ChatUiLaunchTipVariant } from '../../../../shared/native-chat/chat-ui-launch-tip-audience'
import { translate } from '@/i18n/i18n'

export type ShownChatUiLaunchTipVariant = Exclude<ChatUiLaunchTipVariant, 'none'>

export function getChatUiHereVariantCopy(variant: ShownChatUiLaunchTipVariant): {
  paragraphs: string[]
  secondaryLabel: string | null
  primaryLabel: string
} {
  if (variant === 'chat-ui-off') {
    return {
      paragraphs: [
        translate(
          'featureTips.chatUiHere.offIntro',
          'Agents can now open as a chat, with rich messages, visuals and images.'
        ),
        translate(
          'featureTips.chatUiHere.offTerminal',
          'Prefer the terminal? It stays fully supported. Your agents keep opening there until you choose Chat.'
        )
      ],
      secondaryLabel: translate('featureTips.chatUiHere.stayInTerminal', 'Stay in terminal'),
      primaryLabel: translate('featureTips.chatUiHere.cta', 'Use Chat UI')
    }
  }
  return {
    paragraphs: [
      translate(
        'featureTips.chatUiHere.onIntro',
        'Chat UI is out of Experimental and now part of Orca. Your agents keep opening as chats, with rich messages, visuals and images.'
      ),
      translate(
        'featureTips.chatUiHere.onTerminal',
        'The terminal stays fully supported too. Switch any agent back anytime.'
      )
    ],
    secondaryLabel: translate('featureTips.chatUiHere.switchToTerminal', 'Switch to terminal'),
    primaryLabel: translate('featureTips.gotIt', 'Got it')
  }
}
