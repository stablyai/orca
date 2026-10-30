import { translate } from '@/i18n/i18n'
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
  const value0 =
    publisher?.trim() ||
    translate('auto.components.settings.PluginNotOfficialWarning.unknownPublisher', 'its publisher')
  let body: string
  if (notice === 'translations') {
    body = translate(
      'auto.components.settings.PluginNotOfficialWarning.translations',
      'Translations can change any text in Orca. Make sure you trust {{value0}}.',
      { value0 }
    )
  } else if (moment === 'install') {
    body = translate(
      'auto.components.settings.PluginNotOfficialWarning.install',
      'Make sure you trust {{value0}} before installing. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  } else if (moment === 'update') {
    body = translate(
      'auto.components.settings.PluginNotOfficialWarning.update',
      'Make sure you trust {{value0}} before updating. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  } else {
    body = translate(
      'auto.components.settings.PluginNotOfficialWarning.installed',
      'Make sure you trust {{value0}}. This plugin runs the publisher’s code inside Orca.',
      { value0 }
    )
  }
  return (
    <SecuritySurface>
      <div data-plugin-not-official={notice}>
        <PluginWarningBanner
          label={translate(
            'auto.components.settings.PluginNotOfficialWarning.label',
            'Not an official plugin:'
          )}
          body={body}
        />
      </div>
    </SecuritySurface>
  )
}
