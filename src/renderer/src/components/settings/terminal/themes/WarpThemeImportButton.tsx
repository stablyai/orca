import { Button } from '../../../ui/button'
import { WarpIcon } from '../../../icons/WarpIcon'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { useTranslate } from '@/i18n/use-translate'

// Place Warp import with terminal themes, the only output it produces.
export function WarpThemeImportButton({
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
      onClick={() => void warpThemes.handleClick()}
    >
      <WarpIcon className="size-4" />
      {t('auto.components.settings.WarpThemeImportModal.title', 'Import from Warp')}
    </Button>
  )
}
