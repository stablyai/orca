import { FileUp } from 'lucide-react'
import { Button } from '../../../ui/button'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { useTranslate } from '@/i18n/use-translate'

/** Import Warp-format YAML directly through the file picker, independently of Warp discovery. */
export function YamlThemeImportButton({
  warpThemes
}: {
  warpThemes: UseWarpThemeImportReturn
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => void warpThemes.handleImportYamlClick()}
    >
      <FileUp className="size-4" />
      {t('auto.components.settings.YamlThemeImportButton.label', 'Import from YAML')}
    </Button>
  )
}
