import { Laptop, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from './drop-indicator'
import {
  describeClientHostedBrowserRowHost,
  getClientHostedBrowserRowLabel
} from './client-hosted-browser-row-label'
import { preventMiddleButtonDefault } from './middle-button-default-guard'
import { TAB_CONTAINER_WIDTH_CLASSES, TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'

/**
 * A page rendering on a paired client desktop, shown in this host's strip.
 *
 * Intentionally thinner than BrowserTab: no drag, no pin, no reorder, no close-others. Those all
 * act on a unified tab, and this row has none — it is derived from the runtime's page registry and
 * exists only in memory. What it does own is presence and a close.
 */
export default function ClientHostedBrowserTab({
  row,
  isActive,
  hasTabsToRight,
  onActivate,
  onClose,
  includeTopTabBorder = true
}: {
  row: ClientHostedBrowserRow
  isActive: boolean
  hasTabsToRight: boolean
  onActivate: () => void
  onClose: () => void
  includeTopTabBorder?: boolean
}): React.JSX.Element {
  const label = getClientHostedBrowserRowLabel(row)
  const hostDescription = describeClientHostedBrowserRowHost(row)

  return (
    <div className={TAB_CONTAINER_WIDTH_CLASSES}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-client-hosted-browser-row-id={row.browserPageId}
            className={`group relative flex h-full cursor-pointer select-none items-center px-1.5 text-xs outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getTabRootStateClasses(isActive)}`}
            onPointerDown={onActivate}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
              }
            }}
            onMouseUp={preventMiddleButtonDefault}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                event.stopPropagation()
                onClose()
              }
            }}
          >
            {isActive && <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />}
            <Laptop
              className={`mr-1 size-3 shrink-0 ${row.hostAbsent ? 'text-muted-foreground' : 'text-blue-500'}`}
              aria-hidden
            />
            <span
              className={`${TAB_LABEL_WIDTH_CLASSES} mr-1 ${row.hostAbsent ? 'text-muted-foreground' : ''}`}
            >
              {label}
            </span>
            {row.loading && (
              <span className="mr-1 size-1.5 shrink-0 rounded-full bg-sky-500/80" aria-hidden />
            )}
            <button
              type="button"
              aria-label={translate('browser.clientHosted.hostRowClose', 'Close hosted page')}
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm ${
                isActive
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-transparent group-hover:text-muted-foreground hover:!bg-muted hover:!text-foreground'
              }`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={6}
          className="max-w-80 whitespace-normal break-words text-left"
        >
          <div>{label}</div>
          <div className="text-muted-foreground">{hostDescription}</div>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
