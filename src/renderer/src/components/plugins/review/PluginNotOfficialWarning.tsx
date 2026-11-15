import { useTranslate } from '@/i18n/use-translate'
import { SecuritySurface } from '../../ui/security-surface'
import { PluginWarningBanner } from './PluginWarningBanner'

/** Why no dismiss: the publisher, not Orca, vouches for this plugin every time it is shown. */
export function PluginNotOfficialWarning({
  notice,
  publisher,
  moment
}: {
  notice: 'translations' | 'code'
  publisher: string | null
  /** What the reader is about to do, which the advice names. */
  moment: 'install' | 'installed' | 'update'
}): React.JSX.Element {
  const t = useTranslate()
  const value0 =
    publisher?.trim() ||
    t('auto.components.settings.PluginNotOfficialWarning.unknownPublisher', 'its publisher')
  let body: string
  if (notice === 'translations') {
    body = t(
      'auto.components.settings.PluginNotOfficialWarning.translations',
      'Translations can change any text in Orca. Make sure you trust {{value0}}.',
      { value0 }
    )
  } else if (moment === 'install') {
    body = t(
      'auto.components.settings.PluginNotOfficialWarning.install',
      'Make sure you trust {{value0}} before installing. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  } else if (moment === 'update') {
    body = t(
      'auto.components.settings.PluginNotOfficialWarning.update',
      'Make sure you trust {{value0}} before updating. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  } else {
    body = t(
      'auto.components.settings.PluginNotOfficialWarning.installed',
      'Make sure you trust {{value0}}. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  }
  return (
    <SecuritySurface>
      <div data-plugin-not-official={notice}>
        <PluginWarningBanner
          label={t(
            'auto.components.settings.PluginNotOfficialWarning.label',
            'Not an official plugin:'
          )}
          body={body}
        />
      </div>
    </SecuritySurface>
  )
}
