import { translate } from '@/i18n/i18n'
import type {
  NativeChatSessionOptionCopyId,
  NativeChatSessionOptionSay
} from '../../../../shared/native-chat-session-option-labels'

// Literal English defaults: the localization gate only reads string literals at the call site.

const PIECES: Record<NativeChatSessionOptionCopyId, (values?: { value0: string }) => string> = {
  model: () => translate('components.native-chat.composer.model', 'Model'),
  effort: () => translate('components.native-chat.composer.effort', 'Effort'),
  fastMode: () => translate('components.native-chat.composer.fastMode', 'Fast mode'),
  speed: () => translate('components.native-chat.composer.speed', 'Speed'),
  thinking: () => translate('components.native-chat.composer.thinking', 'Thinking'),
  standard: () => translate('components.native-chat.composer.optionValue.standard', 'Standard'),
  minimal: () => translate('components.native-chat.composer.optionValue.minimal', 'Minimal'),
  low: () => translate('components.native-chat.composer.optionValue.low', 'Low'),
  medium: () => translate('components.native-chat.composer.optionValue.medium', 'Medium'),
  high: () => translate('components.native-chat.composer.optionValue.high', 'High'),
  xhigh: () => translate('components.native-chat.composer.optionValue.xhigh', 'Extra high'),
  max: () => translate('components.native-chat.composer.optionValue.max', 'Max'),
  ultra: () => translate('components.native-chat.composer.optionValue.ultra', 'Ultra'),
  minimalShort: () => translate('components.native-chat.composer.optionValueShort.minimal', 'Min'),
  mediumShort: () => translate('components.native-chat.composer.optionValueShort.medium', 'Med'),
  xhighShort: () => translate('components.native-chat.composer.optionValueShort.xhigh', 'XHigh'),
  fast: () => translate('components.native-chat.composer.optionValue.fast', 'Fast'),
  toggleOption: (values) =>
    translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', values),
  chooseInAgentPicker: () =>
    translate('components.native-chat.composer.chooseInAgentPicker', 'Choose in agent picker…'),
  setWhenSessionStarts: () =>
    translate(
      'components.native-chat.composer.setWhenSessionStarts',
      'Set when the session starts.'
    ),
  availableAfterSessionStarts: () =>
    translate(
      'components.native-chat.composer.availableAfterSessionStarts',
      'Available after the session starts.'
    ),
  sessionOptions: () =>
    translate('components.native-chat.composer.sessionOptions', 'Session options')
}

export const sayNativeChatSessionOptionTranslated: NativeChatSessionOptionSay = (id, values) =>
  PIECES[id](values)
