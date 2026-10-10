import { NativeChatExpandable } from './NativeChatExpandable'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { ChevronRight, FilePlus2, FileMinus2, FilePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatToolFileTarget } from './NativeChatToolFileTarget'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import {
  unifiedLineNumber,
  type NativeChatEditFile,
  type NativeChatEditLine
} from '../../../../shared/native-chat-edit-model'

function verbLabel(file: NativeChatEditFile): string {
  switch (file.changeKind) {
    case 'added':
      return translate('components.native-chat.tool.row.added', 'Added')
    case 'deleted':
      return translate('components.native-chat.tool.row.deleted', 'Deleted')
    case 'renamed':
      return translate('components.native-chat.tool.row.renamed', 'Renamed')
    case 'edited':
      return translate('components.native-chat.tool.row.edited', 'Edited')
  }
}

function VerbIcon({ kind }: { kind: NativeChatEditFile['changeKind'] }): React.JSX.Element {
  const className = 'size-3.5 shrink-0 text-chat-foreground-faint'
  if (kind === 'added') {
    return <FilePlus2 className={className} />
  }
  if (kind === 'deleted') {
    return <FileMinus2 className={className} />
  }
  return <FilePen className={className} />
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path
}

function patchText(lines: readonly NativeChatEditLine[]): string {
  return lines
    .filter((line) => line.kind !== 'gap')
    .map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`)
    .join('\n')
}

/** The break between two regions of the file, quiet enough not to read as a
 *  row of content but present enough that the gutter's jump is accounted for. */
function DiffGapRow(): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label={translate('components.native-chat.tool.diffGap', 'Lines not shown')}
      className="select-none border-y border-chat-code-border bg-chat-code-surface py-0.5 text-center text-chat-foreground-faint"
    >
      ⋯
    </div>
  )
}

function DiffRow({ line, gutterWidth }: { line: NativeChatEditLine; gutterWidth: number }) {
  if (line.kind === 'gap') {
    return <DiffGapRow />
  }
  return (
    <div
      className={cn(
        'flex items-start',
        line.kind === 'add' && 'bg-[var(--diff-added-ground)]',
        line.kind === 'del' && 'bg-[var(--diff-removed-ground)]'
      )}
    >
      {gutterWidth > 0 ? (
        <span
          // Why: the gutter carries its own ground so the number column stays
          // legible against a tinted row instead of dissolving into it.
          className={cn(
            'shrink-0 select-none pr-1.5 text-right tabular-nums text-chat-foreground-faint',
            line.kind === 'add' && 'bg-[var(--diff-added-gutter)]',
            line.kind === 'del' && 'bg-[var(--diff-removed-gutter)]',
            line.kind === 'context' && 'bg-chat-code-surface'
          )}
          style={{ width: `${gutterWidth}ch` }}
          aria-hidden
        >
          {unifiedLineNumber(line) ?? ''}
        </span>
      ) : null}
      <span
        className={cn(
          'w-3 shrink-0 select-none text-center',
          line.kind === 'add' && 'text-[var(--git-decoration-added)]',
          line.kind === 'del' && 'text-[var(--git-decoration-deleted)]'
        )}
        aria-hidden
      >
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words pr-2 text-chat-foreground">
        {line.text}
      </span>
    </div>
  )
}

/** The card's rows. Its own component so a collapsed card builds none of them. */
function DiffCardRows({
  lines,
  gutterWidth
}: {
  lines: NativeChatEditFile['lines']
  gutterWidth: number
}): React.JSX.Element {
  const seen = new Map<string, number>()
  return (
    // Focusable so the rows can be scrolled from the keyboard.
    <div
      data-native-chat-code-content
      tabIndex={0}
      className="ml-6 mt-1 max-h-72 overflow-auto rounded-lg border border-chat-code-border bg-chat-code-surface py-1 font-mono text-xs leading-relaxed text-chat-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      {lines.map((line) => {
        const signature = `${line.kind}:${line.oldLineNumber}:${line.newLineNumber}:${line.text}`
        const occurrence = seen.get(signature) ?? 0
        seen.set(signature, occurrence + 1)
        return <DiffRow key={`${signature}:${occurrence}`} line={line} gutterWidth={gutterWidth} />
      })}
    </div>
  )
}

/** Inline card for one file an agent edited: verb header, path with change
 *  counts, and the unified rows. The gutter is blank when the provider gave no
 *  resolved ranges, because a snippet-relative number would read as a file
 *  position. A change reported with no body — a delete names the file and
 *  nothing else — keeps the header rows and offers no empty disclosure. */
export function NativeChatDiffCard({
  file,
  revealSignal,
  onReveal,
  disclosureKey,
  onLinkClick
}: {
  file: NativeChatEditFile
  revealSignal?: number
  onReveal?: (element: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  /** Identity this card's open state is remembered under while it is unmounted. */
  disclosureKey?: string
}): React.JSX.Element {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(disclosureKey, false)
  const cardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (revealSignal && cardRef.current) {
      setExpanded(true)
      // Reported from the card, not the row: a turn that touched four files must
      // land on the one that was asked for, and only the card knows where it is.
      onReveal?.(cardRef.current)
    }
  }, [revealSignal, onReveal, setExpanded])
  // Joining every row to seed the copy button is the card's most expensive
  // work, and a collapsed card renders none of those rows.
  const copyText = useMemo(() => patchText(file.lines), [file.lines])
  const hasBody = file.lines.length > 0
  const widest = file.lineNumbersKnown
    ? file.lines.reduce((max, line) => Math.max(max, unifiedLineNumber(line) ?? 0), 0)
    : 0
  const gutterWidth = file.lineNumbersKnown ? Math.max(3, String(widest).length + 1) : 0

  return (
    <div ref={cardRef} className="my-1 min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => hasBody && setExpanded(!expanded)}
          className={cn(
            'flex min-h-[26px] min-w-0 flex-1 items-center gap-2 text-left font-sans text-[13px]',
            hasBody ? 'cursor-pointer hover:bg-accent/30' : 'cursor-default'
          )}
          aria-expanded={hasBody ? expanded : undefined}
        >
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
            <VerbIcon kind={file.changeKind} />
          </span>
          <span className="shrink-0 text-chat-foreground-faint">{verbLabel(file)}</span>
          {file.oldPath ? (
            <>
              <span
                className="min-w-0 truncate text-chat-foreground-faint line-through"
                title={file.oldPath}
                aria-hidden="true"
              >
                {baseName(file.oldPath)}
              </span>
              <span className="sr-only">{file.oldPath}</span>
              <span className="shrink-0 text-chat-foreground-faint">→</span>
            </>
          ) : null}
          <NativeChatToolFileTarget
            path={file.path}
            label={baseName(file.path)}
            className="min-w-0 truncate text-chat-foreground"
            // A deleted file has nothing left to open.
            onLinkClick={file.changeKind === 'deleted' ? undefined : onLinkClick}
          />
          <DiffLineCounts added={file.added} removed={file.removed} size="sm" />
          {file.truncated ? (
            <span className="shrink-0 text-xs text-chat-foreground-faint">
              {translate('components.native-chat.tool.diffTruncated', 'Diff truncated')}
            </span>
          ) : null}
          {hasBody ? (
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-chat-foreground-faint transition-transform',
                expanded && 'rotate-90'
              )}
            />
          ) : null}
        </button>
        <NativeChatCopyButton
          text={copyText}
          label={translate('components.native-chat.tool.copyDiff', 'Copy diff')}
          className="ml-auto shrink-0"
        />
      </div>
      {hasBody ? (
        <NativeChatExpandable open={expanded}>
          <DiffCardRows lines={file.lines} gutterWidth={gutterWidth} />
        </NativeChatExpandable>
      ) : null}
    </div>
  )
}
