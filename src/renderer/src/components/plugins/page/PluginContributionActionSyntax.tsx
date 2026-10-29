import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../../ui/button'
import { openPluginSampleFromSettings, pluginSyntaxSample } from '../state/plugin-try-action'
import { pluginPanelUnavailableReason } from './plugin-contribution-action-availability'

/** A grammar shows the moment a matching file is open, so Try it opens a sample of one. */
export function PluginContributionSyntaxHint({
  extensions,
  filenames
}: {
  extensions: readonly string[]
  filenames: readonly string[]
}): React.JSX.Element | null {
  const noWorkspace = useAppStore((state) => pluginPanelUnavailableReason(state) !== null)
  const sample = pluginSyntaxSample([{ extensions }])
  if (sample && !noWorkspace) {
    return (
      <Button variant="outline" size="xs" onClick={() => openPluginSampleFromSettings(sample)}>
        {translate('auto.components.settings.pluginInstallAction.tryIt', 'Try it')}
      </Button>
    )
  }
  const extension = extensions[0]
  const filename = filenames[0]
  if (!extension && !filename) {
    return null
  }
  return (
    <span className="text-xs text-muted-foreground">
      {extension
        ? translate(
            'auto.components.settings.PluginContributionActionSyntax.openExtension',
            'Open any {{value0}} file',
            { value0: extension }
          )
        : translate(
            'auto.components.settings.PluginContributionActionSyntax.openFilename',
            'Open {{value0}}',
            { value0: filename }
          )}
    </span>
  )
}
