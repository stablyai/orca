import { Eye, EyeOff, X } from 'lucide-react'
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
  return (
    <div className="mp-page-toolbar">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-full"
            onClick={onClose}
            aria-label={translate("auto.components.mobile.MobilePageToolbar.9883b58693", "Close Orca Mobile")}
          >
            <X className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate("auto.components.mobile.MobilePageToolbar.ad2284a9e2", "Close · Esc")}</TooltipContent>
      </Tooltip>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-2 rounded-md bg-card px-3 text-xs font-medium shadow-xs"
        onClick={onToggleMobileSidebarButton}
      >
        {showMobileButton ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        {showMobileButton ? translate("auto.components.mobile.MobilePageToolbar.c669abcf8f", "Hide from sidebar") : translate("auto.components.mobile.MobilePageToolbar.fb5f28330e", "Show in sidebar")}
      </Button>
    </div>
  )
}
