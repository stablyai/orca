import { Check, FileCode2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'

/** Show workspace path and host identity instead of the guest’s internal preview origin. */
export function DocPreviewDocumentChip({
  identity,
  onBeginEdit
}: {
  identity: DocPreviewDocumentIdentity
  /** When set, a click edits the address instead of copying the path (copy stays in the menu). */
  onBeginEdit?: () => void
}): React.JSX.Element {
  const { copyText, status } = useClipboardTextCopyFeedback(identity.absolutePath)
  const copied = status === 'copied'
  const editLabel = translate(
    'auto.components.editor.HtmlDocPreview.editAddressControl',
    'Edit address'
  )
  const copyLabel = translate(
    'auto.components.editor.HtmlDocPreview.copyDocumentPathControl',
    'Copy file path'
  )
  // Announce copy feedback as text; an icon change alone is invisible to screen readers.
  const copiedLabel = translate(
    'auto.components.editor.HtmlDocPreview.documentPathCopied',
    'Copied'
  )
  const label = onBeginEdit ? editLabel : copied ? copiedLabel : copyLabel

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onBeginEdit ?? (() => void copyText())}
          aria-label={label}
          className="@container flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl border border-border bg-background px-3 py-1 text-left shadow-sm hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {copied ? (
            <Check className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          )}
          {/* Match file-tree emphasis: muted directory, normal filename. */}
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="text-muted-foreground">{identity.directoryPrefix}</span>
            <span className="text-foreground">{identity.fileName}</span>
          </span>
          {/* Hide host details below their minimum readable width; the tooltip retains the full identity. */}
          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground @[24rem]:flex">
            <span className="shrink-0">
              {translate(
                'auto.components.editor.HtmlDocPreview.workspaceFileChipLabel',
                'Workspace file'
              )}
            </span>
            {identity.hostLabel ? (
              <Badge variant="secondary" className="min-w-0 max-w-40 shrink font-normal">
                {/* Ellipsis needs a non-flex text box inside the badge. */}
                <span className="min-w-0 truncate">{identity.hostLabel}</span>
              </Badge>
            ) : null}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {onBeginEdit
          ? `${editLabel} · ${identity.absolutePath}`
          : copied
            ? copiedLabel
            : `${copyLabel} · ${identity.absolutePath}`}
      </TooltipContent>
    </Tooltip>
  )
}
