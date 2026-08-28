import { Check, FileCode2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'

/**
 * The preview's stand-in for an address bar. The guest's real origin is an internal scheme the
 * reader has no use for, so this names the document the way the workspace does — and says whose
 * machine it was read from, which is the part a paired or SSH reader cannot otherwise tell.
 */
export function DocPreviewDocumentChip({
  identity
}: {
  identity: DocPreviewDocumentIdentity
}): React.JSX.Element {
  const { copyText, status } = useClipboardTextCopyFeedback(identity.absolutePath)
  const copied = status === 'copied'
  const copyLabel = translate(
    'auto.components.editor.HtmlDocPreview.copyDocumentPathControl',
    'Copy file path'
  )
  // Why the label swaps: the icon change is the only other feedback, and an icon says nothing to
  // a screen reader — the same trade TerminalLinkActionPopover makes.
  const copiedLabel = translate(
    'auto.components.editor.HtmlDocPreview.documentPathCopied',
    'Copied'
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copyText()}
          aria-label={copied ? copiedLabel : copyLabel}
          className="@container flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl border border-border bg-background px-3 py-1 text-left shadow-sm hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {copied ? (
            <Check className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          )}
          {/* dir/ dimmed, filename normal — the same emphasis the file tree gives a path */}
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="text-muted-foreground">{identity.directoryPrefix}</span>
            <span className="text-foreground">{identity.fileName}</span>
          </span>
          {/* Below 24rem of chip width this row hides whole rather than clipping into slivers —
              384px is what icon + label + a capped badge + a readable path stub need, so visible
              implies contained. The tooltip keeps the full identity either way. */}
          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground @[24rem]:flex">
            <span className="shrink-0">
              {translate(
                'auto.components.editor.HtmlDocPreview.workspaceFileChipLabel',
                'Workspace file'
              )}
            </span>
            {identity.hostLabel ? (
              <Badge variant="secondary" className="min-w-0 max-w-40 shrink font-normal">
                {/* Why the inner span: text directly inside the flex pill clips both ends with no
                    ellipsis — text-overflow needs a non-flex text box. */}
                <span className="min-w-0 truncate">{identity.hostLabel}</span>
              </Badge>
            ) : null}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {copied ? copiedLabel : `${copyLabel} · ${identity.absolutePath}`}
      </TooltipContent>
    </Tooltip>
  )
}
