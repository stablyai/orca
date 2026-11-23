import type React from 'react'
import { MoreHorizontal, Server } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '../../ui/LoadingSpinner'
import { Button } from '../../ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

export type ServerRowStatusTone = 'success' | 'warning' | 'destructive' | 'muted'

export type ServerRowStatus = {
  label: string
  tone: ServerRowStatusTone
  busy?: boolean
}

const STATUS_DOT_CLASS: Record<ServerRowStatusTone, string> = {
  success: 'bg-status-success',
  warning: 'bg-status-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground'
}

const STATUS_LABEL_CLASS: Record<ServerRowStatusTone, string> = {
  success: 'text-muted-foreground',
  warning: 'text-muted-foreground',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground'
}

export function ServerRowChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="max-w-full shrink-0 truncate rounded border border-border bg-accent px-1.5 py-px text-3xs leading-4 text-muted-foreground">
      {children}
    </span>
  )
}

export function ServerRowStatusLabel({ status }: { status: ServerRowStatus }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      {status.busy ? (
        <LoadingSpinner className="size-3 shrink-0" />
      ) : (
        <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[status.tone])} />
      )}
      <span className={cn('truncate', STATUS_LABEL_CLASS[status.tone])}>{status.label}</span>
    </span>
  )
}

type ServerListRowProps = {
  sectionId?: string
  name: string
  /** Who the host is (OS · machine), kept beside the name whatever the meta line says. */
  descriptor?: string | null
  icon?: React.ReactNode
  chips?: React.ReactNode
  meta?: React.ReactNode
  status: ServerRowStatus | null
  primaryAction?: React.ReactNode
  /** DropdownMenu items; null keeps the slot so columns stay aligned. */
  menuItems?: React.ReactNode
  menuDisabled?: boolean
  footer?: React.ReactNode
}

export function ServerListRow({
  sectionId,
  name,
  descriptor,
  icon,
  chips,
  meta,
  status,
  primaryAction,
  menuItems,
  menuDisabled = false,
  footer
}: ServerListRowProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-settings-section={sectionId} className="@container/server-row scroll-mt-8">
      <div className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 px-4 py-2.5 @lg/server-row:grid-cols-[auto_minmax(0,1fr)_8rem_minmax(6rem,max-content)_1.5rem]">
        <span className="shrink-0 text-muted-foreground">
          {icon ?? <Server className="size-4" />}
        </span>
        <div className="contents @lg/server-row:block">
          <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 @lg/server-row:flex-nowrap">
            <span className="max-w-full truncate text-sm font-medium">{name}</span>
            {chips}
            {descriptor ? (
              <span className="max-w-full truncate text-xs text-muted-foreground">
                {descriptor}
              </span>
            ) : null}
          </div>
          {meta ? (
            <div className="col-span-3 col-start-2 row-start-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
        <div className="col-span-3 col-start-2 row-start-3 empty:hidden @lg/server-row:col-span-1 @lg/server-row:col-start-3 @lg/server-row:row-start-1">
          {status ? <ServerRowStatusLabel status={status} /> : null}
        </div>
        <div className="col-start-3 row-start-1 flex justify-end @lg/server-row:col-start-4">
          {primaryAction}
        </div>
        <div className="col-start-4 row-start-1 flex justify-end @lg/server-row:col-start-5">
          {menuItems ? (
            <DropdownMenu modal={false}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={menuDisabled}
                      aria-label={t(
                        'auto.components.settings.serverList.moreActions',
                        'More actions for {{name}}',
                        { name }
                      )}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {t('auto.components.settings.serverList.moreActionsTooltip', 'More actions')}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-52">
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {footer ? <div className="space-y-2 px-4 pb-3 pl-11">{footer}</div> : null}
    </div>
  )
}

export function ServerRowDetailsToggle({
  expanded,
  onToggle
}: {
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      className="shrink-0 cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? t('auto.components.settings.serverList.hideDetails', 'Hide details')
        : t('auto.components.settings.serverList.details', 'Details')}
    </button>
  )
}
