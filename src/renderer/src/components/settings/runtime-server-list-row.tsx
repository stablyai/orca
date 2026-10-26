import type React from 'react'
import { MoreHorizontal, Server } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

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
    <span className="shrink-0 rounded border border-border bg-accent px-1.5 py-px text-3xs leading-4 text-muted-foreground">
      {children}
    </span>
  )
}

export function ServerRowStatusLabel({ status }: { status: ServerRowStatus }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs">
      {status.busy ? (
        <LoadingSpinner className="size-3 shrink-0 text-muted-foreground" />
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
  return (
    <div data-settings-section={sectionId} className="scroll-mt-8">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2.5">
        <span className="shrink-0 text-muted-foreground">
          {icon ?? <Server className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            {chips}
            {descriptor ? (
              <span className="truncate text-xs text-muted-foreground">{descriptor}</span>
            ) : null}
          </div>
          {meta ? (
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
        <div className="w-32 shrink-0">
          {status ? <ServerRowStatusLabel status={status} /> : null}
        </div>
        <div className="flex w-24 shrink-0 justify-end">{primaryAction}</div>
        <div className="flex w-6 shrink-0 justify-end">
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
                      aria-label={translate(
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
                  {translate(
                    'auto.components.settings.serverList.moreActionsTooltip',
                    'More actions'
                  )}
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
  return (
    <button
      type="button"
      className="shrink-0 cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? translate('auto.components.settings.serverList.hideDetails', 'Hide details')
        : translate('auto.components.settings.serverList.details', 'Details')}
    </button>
  )
}
