import { ExternalLink, FolderOpen, MousePointerSquareDashed, RefreshCw, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { OfficeDocKind } from '../../../../../shared/office-file-extensions'
import { DocPreviewDocumentChip } from './doc-preview-document-chip'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'
import { isOfficeRefreshClickable, type OfficeRefreshState } from './office-preview-refresh-state'
import { officeDocKindLabel } from './office-preview-status'

/**
 * Chrome for an Office preview. Deliberately thinner than the HTML document toolbar: there is no
 * address to edit, no history inside a rendered snapshot, and no markup layer over content the
 * reader cannot select — the preview frames someone else's document and should recede.
 */
export function OfficePreviewToolbar({
  identity,
  kind,
  refreshState,
  onRefresh,
  live,
  onToggleLive,
  liveDisabledReason,
  selection,
  onOpenExternally,
  onRevealInFolder
}: {
  identity: DocPreviewDocumentIdentity
  kind: OfficeDocKind
  refreshState: OfficeRefreshState
  onRefresh: () => void
  live: boolean
  onToggleLive: () => void
  /** Non-null disables the toggle and says why, rather than leaving a control that does nothing. */
  liveDisabledReason: string | null
  selection: { enabled: boolean; reason: string | null; onUse: () => void } | null
  onOpenExternally: () => void
  onRevealInFolder: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <DocPreviewDocumentChip identity={identity} />
      <span className="shrink-0 text-[11px] text-muted-foreground">{officeDocKindLabel(kind)}</span>
      <div className="flex-1" />
      {refreshState === 'hidden' ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!isOfficeRefreshClickable(refreshState)}
              onClick={onRefresh}
              aria-label={translate('auto.components.office.preview.rerender', 'Re-render')}
            >
              <RefreshCw
                className={cn(
                  'size-3.5',
                  refreshState === 'updated' ? 'text-accent-foreground' : 'text-muted-foreground'
                )}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {refreshState === 'updated'
              ? translate(
                  'auto.components.office.preview.rerenderUpdated',
                  'This document changed on disk — re-render'
                )
              : translate('auto.components.office.preview.rerender', 'Re-render')}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={live ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2 text-xs"
            disabled={liveDisabledReason !== null}
            onClick={onToggleLive}
          >
            <Zap className="size-3.5" />
            {translate('auto.components.office.preview.live', 'Live')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {liveDisabledReason ??
            translate(
              'auto.components.office.preview.liveHint',
              'Show a live preview that updates as the document is edited'
            )}
        </TooltipContent>
      </Tooltip>
      {selection ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              disabled={!selection.enabled}
              onClick={selection.onUse}
              aria-label={translate('auto.components.office.preview.useSelection', 'Use selection')}
            >
              <MousePointerSquareDashed className="size-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {selection.reason ??
              translate(
                'auto.components.office.preview.useSelectionHint',
                'Put what you selected into the agent composer'
              )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={onRevealInFolder}
        aria-label={translate('auto.components.office.preview.reveal', 'Reveal in folder')}
      >
        <FolderOpen className="size-3.5 text-muted-foreground" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={onOpenExternally}
        aria-label={translate(
          'auto.components.office.preview.openExternally',
          'Open in the system app'
        )}
      >
        <ExternalLink className="size-3.5 text-muted-foreground" />
      </Button>
    </div>
  )
}
