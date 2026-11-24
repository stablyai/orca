import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { openPluginBlankFileFromSettings } from '../state/plugin-try-action'
import { pluginPanelUnavailableReason } from './plugin-contribution-action-availability'

/** A grammar shows the moment a matching file is open, so Try it opens a blank one. */
export function PluginContributionSyntaxHint({
  extensions,
  filenames
}: {
  extensions: readonly string[]
  filenames: readonly string[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const noWorkspace = useAppStore((state) => pluginPanelUnavailableReason(state) !== null)
  const extension = extensions[0]
  const filename = filenames[0]
  if (extension && !noWorkspace) {
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => openPluginBlankFileFromSettings(extension)}
      >
        {t('auto.components.settings.pluginInstallAction.tryIt', 'Try it')}
      </Button>
    )
  }
  if (!extension && !filename) {
    return null
  }
  return (
    <span className="text-xs text-muted-foreground">
      {extension
        ? t(
            'auto.components.settings.PluginContributionActionSyntax.openExtension',
            'Open any {{value0}} file',
            { value0: extension }
          )
        : t(
            'auto.components.settings.PluginContributionActionSyntax.openFilename',
            'Open {{value0}}',
            { value0: filename }
          )}
    </span>
  )
}
