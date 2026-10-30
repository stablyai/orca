import { useCallback, type CSSProperties } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { trackSidebarLiveWidth } from '@/components/sidebar/sidebar-live-width'
import {
  STATUS_BAR_RESERVE_HEIGHT,
  WORKSPACE_TOP_CHROME_HEIGHT
} from '@/components/sidebar/workspace-chrome-metrics'
import UsageDashboardDrawerContent from './UsageDashboardDrawerContent'

type UsageDashboardDrawerProps = {
  leftSidebarStyle?: CSSProperties
  statusBarVisible: boolean
}

/** Companion sheet beside the workspace sidebar; the host keeps it mounted through its close transition. */
export default function UsageDashboardDrawer({
  leftSidebarStyle,
  statusBarVisible
}: UsageDashboardDrawerProps): React.JSX.Element {
  const open = useAppStore((s) => s.usageDrawerOpen)
  const setOpen = useAppStore((s) => s.setUsageDrawerOpen)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const handleClose = useCallback(() => setOpen(false), [setOpen])

  const drawerLeftCss = sidebarOpen
    ? `var(--workspace-sidebar-live-width, ${sidebarWidth}px)`
    : '0px'
  // Reserve the same status-row space as App so the portal cannot cover its controls.
  const drawerBottom = `${statusBarVisible ? STATUS_BAR_RESERVE_HEIGHT : 0}px`

  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetContent
        side="left"
        showCloseButton={false}
        ref={trackSidebarLiveWidth}
        aria-describedby={undefined}
        // Why: the drawer expands from the sidebar edge instead of covering the sidebar.
        className="w-[480px] max-w-[calc(100vw-var(--workspace-sidebar-live-width,0px))] sm:max-w-[calc(100vw-var(--workspace-sidebar-live-width,0px))]"
        overlayStyle={{
          top: WORKSPACE_TOP_CHROME_HEIGHT,
          bottom: drawerBottom,
          left: drawerLeftCss,
          pointerEvents: 'none'
        }}
        style={
          {
            ...leftSidebarStyle,
            left: drawerLeftCss,
            top: WORKSPACE_TOP_CHROME_HEIGHT,
            bottom: drawerBottom,
            height: 'auto'
          } as CSSProperties
        }
        data-usage-dashboard-sheet=""
        onOpenAutoFocus={(event) => {
          // Suppress default header focus, which reveals hover-style affordances without a pointer.
          event.preventDefault()
        }}
      >
        {/* Why: header chrome lives on a plain wrapper; SheetHeader/SheetTitle own their own spacing and type. */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <SheetTitle>
            {translate('auto.components.usageDashboard.UsageDashboardDrawer.title', 'Token usage')}
          </SheetTitle>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
            onClick={handleClose}
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 scrollbar-sleek flex-col overflow-y-auto">
          <UsageDashboardDrawerContent />
        </div>
      </SheetContent>
    </Sheet>
  )
}
