import { useMemo, useState } from 'react'
import { ChevronRight, FilePlus2, FileMinus2, FilePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import {
  unifiedLineNumber,
  type NativeChatEditFile,
  type NativeChatEditLine
} from '../../../../shared/native-chat-edit-model'

function verbLabel(file: NativeChatEditFile): string {
  switch (file.changeKind) {
    case 'added':
      return translate('components.native-chat.tool.addedFile', 'Added file')
    case 'deleted':
      return translate('components.native-chat.tool.deletedFile', 'Deleted file')
    case 'renamed':
      return translate('components.native-chat.tool.renamedFile', 'Renamed file')
    case 'edited':
      return translate('components.native-chat.tool.editedFile', 'Edited file')
  }
}

function VerbIcon({ kind }: { kind: NativeChatEditFile['changeKind'] }): React.JSX.Element {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
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
      className="select-none border-y border-border/60 bg-accent/30 py-0.5 text-center text-muted-foreground"
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
            'shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground',
            line.kind === 'add' && 'bg-[var(--diff-added-gutter)]',
            line.kind === 'del' && 'bg-[var(--diff-removed-gutter)]',
            line.kind === 'context' && 'bg-accent/40'
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
      <span className="min-w-0 whitespace-pre-wrap break-words pr-2 text-foreground/85">
        {line.text}
      </span>
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
  initiallyExpanded = false
}: {
  file: NativeChatEditFile
  initiallyExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  // Joining every row to seed the copy button is the card's most expensive
  // work, and a collapsed card renders none of those rows.
  const copyText = useMemo(() => patchText(file.lines), [file.lines])
  const hasBody = file.lines.length > 0
  const widest = file.lineNumbersKnown
    ? file.lines.reduce((max, line) => Math.max(max, unifiedLineNumber(line) ?? 0), 0)
    : 0
  const gutterWidth = file.lineNumbersKnown ? Math.max(3, String(widest).length + 1) : 0

  return (
    <div className="my-1 overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={() => hasBody && setExpanded((value) => !value)}
        className={cn(
          'group flex w-full items-center gap-1.5 px-2 py-1 text-left',
          hasBody ? 'cursor-pointer hover:bg-accent/30' : 'cursor-default'
        )}
        aria-expanded={hasBody ? expanded : undefined}
      >
        <VerbIcon kind={file.changeKind} />
        <span className="shrink-0 text-[11px] text-muted-foreground group-hover:text-foreground/80">
          {verbLabel(file)}
        </span>
        {hasBody ? (
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
        ) : null}
      </button>
      <div className="flex items-center gap-1.5 border-t border-border bg-accent/40 px-2 py-1">
        {file.oldPath ? (
          <>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground line-through">
              {baseName(file.oldPath)}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">→</span>
          </>
        ) : null}
        <span
          className="min-w-0 truncate font-mono text-[11px] font-medium text-foreground"
          title={file.path}
        >
          {baseName(file.path)}
        </span>
        <DiffLineCounts added={file.added} removed={file.removed} />
        {file.truncated ? (
          // Beside the counts rather than under the rows: a collapsed card, and
          // one clipped down to no rows at all, would otherwise say nothing.
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {translate('components.native-chat.tool.diffTruncated', 'Diff truncated')}
          </span>
        ) : null}
        <NativeChatCopyButton
          text={copyText}
          label={translate('components.native-chat.tool.copyDiff', 'Copy diff')}
          className="ml-auto shrink-0"
        />
      </div>
      {hasBody && expanded ? (
        // Focusable so the rows can be scrolled from the keyboard.
        <div
          tabIndex={0}
          className="max-h-72 overflow-auto font-mono text-[11px] leading-relaxed scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          {(() => {
            const seen = new Map<string, number>()
            return file.lines.map((line) => {
              const signature = `${line.kind}:${line.oldLineNumber}:${line.newLineNumber}:${line.text}`
              const occurrence = seen.get(signature) ?? 0
              seen.set(signature, occurrence + 1)
              return (
                <DiffRow key={`${signature}:${occurrence}`} line={line} gutterWidth={gutterWidth} />
              )
            })
          })()}
        </div>
      ) : null}
    </div>
  )
}
