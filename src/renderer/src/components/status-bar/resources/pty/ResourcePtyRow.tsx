import { memo } from 'react'
import type React from 'react'
import { AlertCircle, ArrowUpRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { cn } from '@/lib/class-names'
import type { ResourcePtyRow as PtyRow } from './resource-pty-view-model'
import { ResourcePtyDetails } from './ResourcePtyDetails'
import { ResourcePtyProcessIcon } from './ResourcePtyProcessIcon'
import { ptyTerminationReason } from './use-resource-pty-actions'

// An unbound PTY's title is often just its process name, which the icon already shows.
function titleRepeatsProcess(row: PtyRow): boolean {
  const process = row.session.foregroundProcess?.trim().toLowerCase()
  return !!process && row.label.trim().toLowerCase().split(' ')[0] === process
}

export const ResourcePtyRow = memo(function ResourcePtyRow({
  row,
  showWorkspace,
  observedAt,
  unverifiable,
  ending,
  error,
  selected,
  detailsOpen,
  onActivate,
  onEnd,
  onNavigate
}: {
  row: PtyRow
  showWorkspace: boolean
  observedAt: number | null
  unverifiable: boolean
  ending: boolean
  error?: string
  selected: boolean
  detailsOpen: boolean
  onActivate: (row: PtyRow, event: React.MouseEvent) => void
  onEnd: (row: PtyRow) => void
  onNavigate: (tabId: string, paneKey: string | null) => void
}) {
  const t = useTranslate()
  useUiLanguageRevision()
  const endUnavailable = unverifiable
    ? t('resourceManager.pty.refreshBeforeEnd', 'End is unavailable until PTYs are refreshed.')
    : !row.session.incarnationId || !row.session.fencedTermination
      ? ptyTerminationReason('unsupported', t)
      : null
  const process = row.session.foregroundProcess?.trim()
  const swapForWorkspace = showWorkspace && !!row.workspace && titleRepeatsProcess(row)
  const label = swapForWorkspace ? row.workspace : row.label
  const workspace = showWorkspace && !swapForWorkspace ? row.workspace : null
  return (
    <div data-resource-pty-row={row.identity} data-selected={selected}>
      <div
        className={cn(
          'group/row flex h-[26px] items-center gap-1.5 pr-2',
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
          ending && 'text-muted-foreground'
        )}
      >
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={(event) => onActivate(row, event)}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-6 text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {process ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                  <ResourcePtyProcessIcon process={process} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {process}
              </TooltipContent>
            </Tooltip>
          ) : (
            <ResourcePtyProcessIcon process={undefined} />
          )}
          <span className="min-w-0 truncate">{label}</span>
          {workspace && (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{workspace}</span>
          )}
        </button>
        <div className="flex w-[72px] shrink-0 items-center justify-end gap-0.5">
          {ending ? (
            <span className="flex items-center gap-1 text-2xs text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />
              <span className="truncate">{t('resourceManager.pty.ending', 'Ending…')}</span>
            </span>
          ) : error ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="alert"
                  tabIndex={0}
                  className="flex min-w-0 items-center gap-1 rounded-sm text-2xs text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AlertCircle aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">{t('resourceManager.pty.notEnded', 'Not ended')}</span>
                  <span className="sr-only">{error}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {error}
              </TooltipContent>
            </Tooltip>
          ) : (
            <div className="flex items-center gap-0.5 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
              {row.tabId && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-5"
                      aria-label={t('resourceManager.pty.openNamed', 'Open {{terminal}}', {
                        terminal: row.label
                      })}
                      onClick={() => {
                        if (row.tabId) {
                          onNavigate(row.tabId, row.paneKey)
                        }
                      }}
                    >
                      <ArrowUpRight className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {t('resourceManager.pty.goToTerminal', 'Go to terminal')}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex" tabIndex={endUnavailable ? 0 : undefined}>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-2xs hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15"
                      disabled={!!endUnavailable}
                      aria-label={t('resourceManager.pty.endNamed', 'End {{terminal}}', {
                        terminal: row.label
                      })}
                      onClick={() => onEnd(row)}
                    >
                      {t('resourceManager.pty.endShort', 'End')}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>
                  {endUnavailable ??
                    t('resourceManager.pty.endHint', 'End this terminal and its child processes.')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
      {detailsOpen && <ResourcePtyDetails row={row} observedAt={observedAt} />}
    </div>
  )
})
