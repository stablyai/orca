import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { isUsablePluginLanguagePack } from '../../../../../shared/plugins/languages/plugin-language-pack-coverage'
import type { UiLanguage } from '../../../../../shared/i18n/ui-language'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { languageDisplayName } from '@/i18n/ui-intl-formatters'
import {
  selectUiLanguage,
  restorePreviousUiLanguage,
  showLanguageSelectionError
} from '@/components/languages/language-selection'

function applyUiLanguage(uiLanguage: UiLanguage): Promise<boolean> {
  return selectUiLanguage(uiLanguage).then(
    (changed) => changed,
    (cause: unknown) => {
      toast.error(
        translate(
          'auto.components.settings.PluginContributionActionLanguage.failed',
          'Could not switch language'
        ),
        { description: cause instanceof Error ? cause.message : String(cause) }
      )
      return false
    }
  )
}

/** Switches the UI to a plugin's language pack, remembering the language to switch back to. */
export function switchToPluginLanguage(pack: PluginLanguagePackRegistration): Promise<boolean> {
  return applyUiLanguage(pack.id)
}

export function switchBackFromPluginLanguage(): void {
  void restorePreviousUiLanguage().catch(showLanguageSelectionError)
}

/** Switches the UI to a plugin's language pack, with a way back; never applied unasked. */
export function PluginContributionActionLanguage({
  pack
}: {
  pack: PluginLanguagePackRegistration
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const settings = useAppStore((state) => state.settings)
  if (!settings || !isUsablePluginLanguagePack(pack)) {
    return null
  }
  const name = languageDisplayName(pack.locale, intlLocale)
  if (settings.uiLanguage === pack.id) {
    return (
      <Button
        variant="outline"
        size="xs"
        aria-label={t(
          'auto.components.settings.PluginContributionActionLanguage.switchBackFrom',
          'Switch back from {{value0}}',
          { value0: name }
        )}
        onClick={switchBackFromPluginLanguage}
      >
        {t('auto.components.settings.PluginContributionActionLanguage.switchBack', 'Switch back')}
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="xs"
      aria-label={t(
        'auto.components.settings.PluginContributionActionLanguage.switchTo',
        'Switch language to {{value0}}',
        { value0: name }
      )}
      onClick={() => void switchToPluginLanguage(pack)}
    >
      {t('auto.components.settings.PluginContributionActionLanguage.switch', 'Switch language')}
    </Button>
  )
}
