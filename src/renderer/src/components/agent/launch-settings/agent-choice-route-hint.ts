import { translate } from '../../../i18n/i18n'
import type { Translate } from '../../../i18n/use-translate'
import type { SourceControlActionChoiceRoute } from '../../../../../shared/source-control/ai/recipes/source-control-action-options'

/** Says which launches a saved choice reaches when it is not both. */
export function sourceControlActionRouteHint(
  route: SourceControlActionChoiceRoute,
  t: Translate = translate
): string | null {
  return route === 'chats'
    ? t('settings.sourceControl.actionModel.chatsOnly', 'Applies to chats only')
    : route === 'terminals'
      ? t('settings.sourceControl.actionModel.terminalsOnly', 'Applies to terminals only')
      : null
}
