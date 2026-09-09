import { AlertCircle, ExternalLink, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { OfficeErrorCode } from '../../../../../shared/office-preview-contracts'
import { officeFailureDetail, officeFailureTitle } from './office-preview-status'

/**
 * A refusal a reader can act on. The failure detail from the host is available but folded away —
 * it is the tool's wording, not ours, and putting it first would make every failure read like a
 * stack trace.
 */
export function OfficePreviewFailurePanel({
  code,
  detail,
  hostLabel,
  onRetry,
  onOpenExternally
}: {
  code: OfficeErrorCode
  detail?: string
  hostLabel: string | null
  onRetry: (() => void) | null
  onOpenExternally: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <AlertCircle className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{officeFailureTitle(code)}</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {officeFailureDetail(code, hostLabel)}
      </p>
      <div className="flex items-center gap-2 pt-1">
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.office.preview.tryAgain', 'Try again')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onOpenExternally}>
          <ExternalLink className="size-3.5" />
          {translate('auto.components.office.preview.openExternally', 'Open in the system app')}
        </Button>
      </div>
      {detail ? (
        <details className="max-w-md pt-1 text-left">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            {translate('auto.components.office.preview.showDetail', 'What the tool said')}
          </summary>
          <p className="mt-1 select-text break-words font-mono text-[11px] text-muted-foreground">
            {detail}
          </p>
        </details>
      ) : null}
    </div>
  )
}

/**
 * The unrenderable-format panel.
 *
 * Separate from the failure panel on purpose: this is not a failure, and it must never mention
 * `officecli`. The tool was not the problem, and offering an install would send the reader to fix
 * something that is already fine.
 */
export function OfficeUnrenderablePanel({
  message,
  onOpenExternally,
  onRevealInFolder
}: {
  message: string
  onOpenExternally: () => void
  onRevealInFolder: (() => void) | null
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="secondary" onClick={onOpenExternally}>
          <ExternalLink className="size-3.5" />
          {translate('auto.components.office.preview.openExternally', 'Open in the system app')}
        </Button>
        {onRevealInFolder ? (
          <Button size="sm" variant="ghost" onClick={onRevealInFolder}>
            {translate('auto.components.office.preview.reveal', 'Reveal in folder')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
