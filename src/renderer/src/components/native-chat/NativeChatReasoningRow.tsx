import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

function firstNonEmptyLinePreview(markdown: string): string {
  let start = 0
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start)
    const end = newline === -1 ? markdown.length : newline
    const line = markdown.slice(start, end)
    if (line.trim()) {
      return line.slice(0, 80)
    }
    start = end + 1
  }
  return ''
}

/** Reasoning folds to a one-line disclosure like a tool run — thinking is
 *  process, not answer, so it stays out of the way until asked for. */
export function NativeChatReasoningRow({
  markdown,
  expandSignal,
  onLinkClick,
  allowFileUriLinks
}: {
  markdown: string
  /** Toolbar-driven desired open state. Each change re-syncs this row's state. */
  expandSignal: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(expandSignal)
  useEffect(() => setOpen(expandSignal), [expandSignal])

  const preview = useMemo(() => firstNonEmptyLinePreview(markdown), [markdown])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        type="button"
        className="group flex w-full items-center gap-1.5 rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground transition-colors group-hover:text-foreground/80">
          {translate('components.native-chat.reasoning.label', 'Thinking')}
        </span>
        {!open && preview ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] italic text-muted-foreground transition-colors group-hover:text-foreground/70"
            title={preview}
          >
            {preview}
          </span>
        ) : null}
        {/* Chevron on the right, revealed on hover/keyboard focus when collapsed
            and pointing down when open — matches the tool-run disclosure. */}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-all',
            open
              ? 'rotate-90 opacity-100'
              : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 border-l-2 border-border/60 pl-3 italic text-muted-foreground">
          <CommentMarkdown
            content={markdown}
            variant="document"
            className="text-sm"
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
