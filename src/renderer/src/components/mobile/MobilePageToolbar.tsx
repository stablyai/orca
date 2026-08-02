import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type MobilePageToolbarProps = {
  showMobileButton: boolean
  onClose: () => void
  onToggleMobileSidebarButton: () => void
}

export function MobilePageToolbar({
  showMobileButton,
  onClose,
  onToggleMobileSidebarButton
}: MobilePageToolbarProps): React.JSX.Element {
  const sidebarToggleLabel = showMobileButton
    ? translate('auto.components.mobile.MobilePageToolbar.c669abcf8f', 'Hide from sidebar')
    : translate('auto.components.mobile.MobilePageToolbar.fb5f28330e', 'Show in sidebar')
  const sidebarToggleTooltip = showMobileButton
    ? translate(
        'auto.components.mobile.MobilePageToolbar.e1c7b4a92d',
        'Configure in Settings > Mobile.'
      )
    : translate(
        'auto.components.mobile.MobilePageToolbar.f3d8e5b71a',
        'Adds the shortcut back to the sidebar.'
      )

  return (
    <div className="mp-page-toolbar">
      <div className="mp-page-toolbar-primary">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={showMobileButton ? 'default' : 'secondary'}
              size="sm"
              className="mp-sidebar-toggle-btn"
              onClick={onToggleMobileSidebarButton}
              aria-label={sidebarToggleLabel}
            >
              {sidebarToggleLabel}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {sidebarToggleTooltip}
          </TooltipContent>
        </Tooltip>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="mp-page-toolbar-close size-7 shrink-0 rounded-full"
            onClick={onClose}
            aria-label={translate(
              'auto.components.mobile.MobilePageToolbar.9883b58693',
              'Close Orca Mobile'
            )}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.mobile.MobilePageToolbar.ad2284a9e2', 'Close · Esc')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
