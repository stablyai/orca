import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

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
  // Re-sync when the global toolbar toggle flips.
  useEffect(() => setOpen(expandSignal), [expandSignal])

  const preview =
    markdown
      .split('\n')
      .find((line) => line.trim())
      ?.slice(0, 80) ?? ''

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 py-0.5 text-left"
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
      </button>
      {open ? (
        <div className="mt-1 border-l-2 border-border/60 pl-3 italic text-muted-foreground">
          <CommentMarkdown
            content={markdown}
            variant="document"
            className="text-sm"
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </div>
      ) : null}
    </div>
  )
}
