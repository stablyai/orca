import { FileUp } from 'lucide-react'
import { Button } from '../ui/button'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { translate } from '@/i18n/i18n'

/** Imports theme YAML files (Warp format) straight from a native file picker,
 *  without routing through Warp auto-discovery. */
export function YamlThemeImportButton({
  warpThemes
}: {
  warpThemes: UseWarpThemeImportReturn
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => void warpThemes.handleImportYamlClick()}
    >
      <FileUp className="size-4" />
      {translate('auto.components.settings.YamlThemeImportButton.label', 'Import from YAML')}
    </Button>
  )
}
