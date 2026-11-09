import type { Translate } from '@/i18n/use-translate'
import type { SessionOptionDescriptor } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import {
  nativeChatOptionValuesLabel,
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'
import { nativeChatPermissionCurrentLabel } from './native-chat-permission-mode-labels'

/** Effort, other option values and access, e.g. "Low effort · Full access"; empty when none apply. */
export function compactSelectionDetail(
  options: readonly SessionOptionDescriptor[],
  permission: SessionOptionDescriptor | undefined,
  t: Translate
): string {
  const effort = options.find((descriptor) => descriptor.id === 'effort')
  const effortChoice =
    effort && effort.valueSource !== 'unknown' ? selectedNativeChatChoice(effort) : null
  const access =
    permission?.kind.type === 'select'
      ? nativeChatPermissionCurrentLabel(
          permission.valueSource === 'unknown' ? undefined : permission.kind.currentValue,
          permission.description,
          t
        )
      : null
  return [
    effortChoice
      ? t('components.native-chat.composer.effortSummary', '{{value0}} effort', {
          value0: nativeChatSessionChoiceLabel(effortChoice, say, 'effort')
        })
      : '',
    nativeChatOptionValuesLabel(
      options.filter((descriptor) => descriptor.id !== 'effort'),
      say
    ),
    access ?? ''
  ]
    .filter(Boolean)
    .join(' · ')
}
