import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ComposerAutocomplete } from '../../../../../../shared/native-chat/input/native-chat-composer-autocomplete'

/** While the host checks for new skills, an empty filter says so instead of reporting no match. */
export function nativeChatPickerEmptyText(
  autocomplete: Extract<ComposerAutocomplete, { mode: 'slash' }>,
  t: Translate = translate,
  checking = false
): string {
  if (checking) {
    return t('components.native-chat.composer.checkingSkills', 'Checking for new skills...')
  }
  if (!autocomplete.commandsEnabled) {
    return t('components.native-chat.composer.noSkills', 'No matching skills')
  }
  if (autocomplete.skillsEnabled) {
    return t('components.native-chat.composer.noCommandsOrSkills', 'No matching commands or skills')
  }
  return t('components.native-chat.composer.noCommands', 'No matching commands')
}
