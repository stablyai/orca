import type { PluginLanguagePackRegistration } from '../../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { isUsablePluginLanguagePack } from '../../../../../shared/plugins/plugin-language-pack-coverage'
import { UI_LANGUAGE_SYSTEM, type UiLanguage } from '../../../../../shared/ui-language'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { languageDisplayName } from '../presentation/plugin-contributions'

// Why module state: settings have no "language before plugin" field, and the page may unmount
// between switching and switching back. Falls back to following the system language.
let uiLanguageBeforeSwitch: UiLanguage | null = null

/** Switches the UI to a plugin's language pack, with a way back; never applied unasked. */
export function PluginContributionActionLanguage({
  pack
}: {
  pack: PluginLanguagePackRegistration
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  if (!settings || !isUsablePluginLanguagePack(pack)) {
    return null
  }
  const name = languageDisplayName(pack.locale)
  const apply = (uiLanguage: UiLanguage): void => {
    updateSettings({ uiLanguage }).catch((cause: unknown) => {
      toast.error(
        translate(
          'auto.components.settings.PluginContributionActionLanguage.failed',
          'Could not switch language'
        ),
        { description: cause instanceof Error ? cause.message : String(cause) }
      )
    })
  }
  if (settings.uiLanguage === pack.id) {
    return (
      <Button
        variant="outline"
        size="xs"
        aria-label={translate(
          'auto.components.settings.PluginContributionActionLanguage.switchBackFrom',
          'Switch back from {{value0}}',
          { value0: name }
        )}
        onClick={() => {
          const previous = uiLanguageBeforeSwitch ?? UI_LANGUAGE_SYSTEM
          uiLanguageBeforeSwitch = null
          apply(previous)
        }}
      >
        {translate(
          'auto.components.settings.PluginContributionActionLanguage.switchBack',
          'Switch back'
        )}
      </Button>
    )
  }
  return (
    <Button
      variant="outline"
      size="xs"
      aria-label={translate(
        'auto.components.settings.PluginContributionActionLanguage.switchTo',
        'Switch language to {{value0}}',
        { value0: name }
      )}
      onClick={() => {
        // Why keep the first one: hopping between plugin packs must not lose the original.
        uiLanguageBeforeSwitch ??= settings.uiLanguage
        apply(pack.id)
      }}
    >
      {translate(
        'auto.components.settings.PluginContributionActionLanguage.switch',
        'Switch language'
      )}
    </Button>
  )
}
