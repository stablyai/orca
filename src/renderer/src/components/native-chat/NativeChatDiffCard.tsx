import { NativeChatExpandable } from './NativeChatExpandable'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { ChevronRight, FilePlus2, FileMinus2, FilePen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { DiffLineCounts } from '../right-sidebar/source-control/listing/diff-line-counts'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatToolFileTarget } from './NativeChatToolFileTarget'
import { nativeChatToolRowVerb } from './native-chat-tool-line-label'
import { nativeChatEditFilePatchText } from '../../../../shared/native-chat/tools/native-chat-edit-cards'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import {
  nativeChatEditFileBaseName,
  nativeChatEditGutterChars,
  unifiedLineNumber,
  type NativeChatEditFile,
  type NativeChatEditLine
} from '../../../../shared/native-chat/tools/native-chat-edit-model'

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

/** Mark omitted file regions so gutter line jumps do not resemble missing rendered content. */
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
          // Give gutter numbers their own background to keep them legible on tinted diff rows.
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
          line.kind === 'add' && 'text-chat-diff-added',
          line.kind === 'del' && 'text-chat-diff-removed'
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

/** Mount rows separately so collapsed cards do not build their DOM. */
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
      className="ml-6 mt-1 max-h-72 overflow-auto rounded-lg border border-chat-code-border bg-chat-code-surface py-1 font-mono text-chat-code leading-relaxed text-chat-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

/** Render file edits without invented line numbers; header-only changes have no empty disclosure. */
export function NativeChatDiffCard({
  file,
  revealSignal,
  onReveal,
  disclosureKey,
  initialOpen = false,
  onLinkClick
}: {
  file: NativeChatEditFile
  revealSignal?: number
  onReveal?: (element: HTMLElement) => void
  onLinkClick?: CommentMarkdownLinkClickHandler
  /** Identity this card's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  initialOpen?: boolean
}): React.JSX.Element {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(
    disclosureKey,
    initialOpen
  )
  const cardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (revealSignal && cardRef.current) {
      setExpanded(true)
      // Reveal the requested file’s own card, not the enclosing turn that may contain several files.
      onReveal?.(cardRef.current)
    }
  }, [revealSignal, onReveal, setExpanded])
  const copyText = useMemo(() => nativeChatEditFilePatchText(file.lines), [file.lines])
  const hasBody = file.lines.length > 0
  const gutterWidth = nativeChatEditGutterChars(file)

  return (
    <div ref={cardRef} className="my-1 min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => hasBody && setExpanded(!expanded)}
          className={cn(
            'flex min-h-6.5 min-w-0 flex-1 items-center gap-2 rounded-md text-left font-sans text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            hasBody ? 'cursor-pointer hover:bg-accent/20' : 'cursor-default'
          )}
          aria-expanded={hasBody ? expanded : undefined}
        >
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
            <VerbIcon kind={file.changeKind} />
          </span>
          <span className="shrink-0 text-chat-foreground-faint">
            {nativeChatToolRowVerb(file.changeKind)}
          </span>
          {file.oldPath ? (
            <>
              <span
                className="min-w-0 truncate text-chat-foreground-faint line-through"
                title={file.oldPath}
                aria-hidden="true"
              >
                {nativeChatEditFileBaseName(file.oldPath)}
              </span>
              <span className="sr-only">{file.oldPath}</span>
              <span className="shrink-0 text-chat-foreground-faint">→</span>
            </>
          ) : null}
          <NativeChatToolFileTarget
            path={file.path}
            label={nativeChatEditFileBaseName(file.path)}
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
                'size-3.5 shrink-0 text-chat-foreground-faint transition-transform motion-reduce:transition-none',
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
