import { translate } from '@/i18n/i18n'

/** There is nothing to click for a grammar: it shows the moment a matching file is open. */
export function PluginContributionSyntaxHint({
  extensions,
  filenames
}: {
  extensions: readonly string[]
  filenames: readonly string[]
}): React.JSX.Element | null {
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
