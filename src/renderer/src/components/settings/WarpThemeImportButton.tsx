import { Button } from '../ui/button'
import { WarpIcon } from '../icons/WarpIcon'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { translate } from '@/i18n/i18n'

// Place Warp import with terminal themes, the only output it produces.
export function WarpThemeImportButton({
  warpThemes
}: {
  warpThemes: UseWarpThemeImportReturn
}): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => void warpThemes.handleClick()}
    >
      <WarpIcon className="size-4" />
      {translate('auto.components.settings.WarpThemeImportModal.title', 'Import from Warp')}
    </Button>
  )
}
