import { FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  EDITOR_READ_OVERRIDE_CEILING_BYTES,
  formatFileReadBytes,
  type FileTooLargeDetail
} from '../../../../shared/editor-file-read-limit'

// Why: a refusal that already names the ceiling as the limit it applied is the
// second refusal — the budget was lifted and the read still would not fit.
function refusedAtOverrideCeiling(detail: FileTooLargeDetail): boolean {
  return (
    detail.scope === 'local' &&
    detail.limitBytes !== undefined &&
    detail.limitBytes >= EDITOR_READ_OVERRIDE_CEILING_BYTES
  )
}

// Why: no scope means the refusal arrived as the bare protocol token, so there
// is no transport to attribute the budget to. The local paragraph is assembled
// from what this render actually shows: promising the override in prose while
// the button is withheld is a claim the same render just contradicted.
function describeLimitOwner(detail: FileTooLargeDetail, canOpenAnyway: boolean): string | null {
  const { scope } = detail
  if (scope === undefined) {
    return null
  }
  if (scope === 'ssh') {
    return translate(
      'auto.components.editor.LargeFileFallback.scopeSsh',
      'Files read over SSH share the connection with your terminals, so they use a smaller budget than local files.'
    )
  }
  if (scope === 'runtime') {
    return translate(
      'auto.components.editor.LargeFileFallback.scopeRuntime',
      'Files read from a remote workspace travel over the workspace connection, so they use a smaller budget than local files.'
    )
  }
  const budget = translate(
    'auto.components.editor.LargeFileFallback.scopeLocal',
    'Local files use the largest budget Orca opens without asking.'
  )
  if (canOpenAnyway) {
    return `${budget} ${translate(
      'auto.components.editor.LargeFileFallback.localOverridable',
      'You can open it anyway, but the editor may become slow.'
    )}`
  }
  if (refusedAtOverrideCeiling(detail)) {
    return `${budget} ${translate(
      'auto.components.editor.LargeFileFallback.localAtCeiling',
      'This file is past the largest size the editor can hold, so opening it anyway would refuse again.'
    )}`
  }
  return budget
}

export function LargeFileFallback({
  filePath,
  detail,
  onOpenAnyway
}: {
  filePath: string
  detail: FileTooLargeDetail
  /** Absent when the transport that refused cannot honour an override. */
  onOpenAnyway?: () => void
}): React.JSX.Element {
  const limitOwner = describeLimitOwner(detail, onOpenAnyway !== undefined)
  return (
    <div
      data-testid="large-file-fallback"
      className="flex h-full min-h-[120px] items-center justify-center border border-border bg-muted/10 px-4 py-6 text-muted-foreground"
    >
      <div className="max-w-xl space-y-3 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.editor.LargeFileFallback.title',
            'This file is too large to open in the editor.'
          )}
        </div>
        <div className="break-all text-xs">{filePath}</div>
        <div className="grid gap-1 text-xs sm:grid-cols-2 sm:text-left">
          {detail.byteLength !== undefined && (
            <div>
              {translate('auto.components.editor.LargeFileFallback.size', 'File size')}:{' '}
              {formatFileReadBytes(detail.byteLength)}
            </div>
          )}
          {detail.limitBytes !== undefined && (
            <div>
              {translate('auto.components.editor.LargeFileFallback.limit', 'Read limit')}:{' '}
              {formatFileReadBytes(detail.limitBytes)}
            </div>
          )}
        </div>
        {limitOwner !== null && <div className="text-[11px]">{limitOwner}</div>}
        {onOpenAnyway && (
          <Button type="button" variant="secondary" size="xs" onClick={onOpenAnyway}>
            <FileWarning />
            {translate('auto.components.editor.LargeFileFallback.openAnyway', 'Open Anyway')}
          </Button>
        )}
      </div>
    </div>
  )
}
