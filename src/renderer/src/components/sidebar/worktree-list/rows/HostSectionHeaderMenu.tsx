import React, { useState } from 'react'
import { Ellipsis, Loader2 } from 'lucide-react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { useTranslate } from '@/i18n/use-translate'
import type { HostHeaderRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'

const LazyHostSectionHeaderMenuBody = lazyWithRetry(
  () =>
    import('./HostSectionHeaderMenuBody').then((module) => ({
      default: module.HostSectionHeaderMenuBody
    })),
  { reloadKey: 'host-section-header-menu-body' }
)

export function HostSectionHeaderMenu({ row }: { row: HostHeaderRow }): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const hasOpened = useLatchedOpen(open)

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="size-5 shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity focus-visible:opacity-100 group-hover/host-header:opacity-100 data-[state=open]:opacity-100"
              aria-label={t(
                'auto.components.sidebar.HostSectionHeaderMenu.4f2c8a9b10',
                'Host actions for {{value0}}',
                { value0: row.label }
              )}
              // Opening the menu must not bubble into host-section collapse.
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Ellipsis className="size-3.5" />
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('auto.components.sidebar.HostSectionHeaderMenu.6b7c8d9e10', 'Host actions')}
        </TooltipContent>
      </Tooltip>
      {hasOpened ? (
        <React.Suspense fallback={null}>
          <LazyHostSectionHeaderMenuBody row={row} onBusyChange={setBusy} />
        </React.Suspense>
      ) : null}
    </DropdownMenu>
  )
}
