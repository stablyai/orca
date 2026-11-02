import { FileUp } from 'lucide-react'
import { Button } from '../ui/button'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { translate } from '@/i18n/i18n'

/** Import Warp-format YAML directly through the file picker, independently of Warp discovery. */
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
