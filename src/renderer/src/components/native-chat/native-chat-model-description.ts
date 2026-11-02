import { translate } from '@/i18n/i18n'

export function nativeChatModelDescription(
  value: string,
  description: string | undefined
): string | undefined {
  switch (value) {
    case 'grok-4.7':
      return description === "xAI's latest frontier model"
        ? translate(
            'components.native-chat.modelDescriptions.grok_4_7',
            "xAI's latest frontier model"
          )
        : description
    case 'grok-4.6':
      return description === "xAI's previous frontier model"
        ? translate(
            'components.native-chat.modelDescriptions.grok_4_6',
            "xAI's previous frontier model"
          )
        : description
    case 'grok-4.5':
      return description === 'An earlier xAI frontier model'
        ? translate(
            'components.native-chat.modelDescriptions.grok_4_5',
            'An earlier xAI frontier model'
          )
        : description
    case 'fable':
      return description === 'Most capable for the hardest, longest-running tasks'
        ? translate(
            'components.native-chat.modelDescriptions.fable',
            'Most capable for the hardest, longest-running tasks'
          )
        : description
    case 'opus':
      return description === 'Best for everyday, complex tasks'
        ? translate(
            'components.native-chat.modelDescriptions.opus',
            'Best for everyday, complex tasks'
          )
        : description
    case 'sonnet':
      return description === 'Efficient for routine tasks'
        ? translate(
            'components.native-chat.modelDescriptions.sonnet',
            'Efficient for routine tasks'
          )
        : description
    case 'haiku':
      return description === 'Fastest for quick answers'
        ? translate('components.native-chat.modelDescriptions.haiku', 'Fastest for quick answers')
        : description
    default:
      return description
  }
}
