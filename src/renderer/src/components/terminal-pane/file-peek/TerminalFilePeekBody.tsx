import { Link } from 'lucide-react'
import { FileTypeIcon, FolderIcon } from '@/components/FileTypeIcon'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { TerminalFileContext } from '../terminal-file-path-mapping'
import type { TerminalFilePeekContent } from './terminal-file-peek-content-types'
import { TERMINAL_FILE_PEEK_MARKDOWN_EXTENSION } from './terminal-file-peek-markdown'
import { TerminalFilePeekBodyImage } from './TerminalFilePeekBodyImage'
import { TerminalFilePeekBodyScroll } from './TerminalFilePeekBodyScroll'
import { TerminalFilePeekBodyText } from './TerminalFilePeekBodyText'

type NoticeReason = Extract<TerminalFilePeekContent, { kind: 'notice' }>['reason']

// Compact markdown renders blocks as spans, so spacing and heading scale come from here.
const MARKDOWN_CLASS =
  'pl-1 text-xs leading-normal [&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-1.5 [&>*+*]:mt-1.5 [&_.comment-md-h]:mt-2 [&_.comment-md-h]:mb-0.5 [&_.comment-md-h]:block [&_.comment-md-h:first-child]:mt-0 [&_.comment-md-h1]:text-sm [&_.overflow-x-auto]:overflow-hidden'
const LOADING_BAR_WIDTHS = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3'] as const

function noticeText(reason: NoticeReason): string {
  switch (reason) {
    case 'binary':
      return translate('terminal.filePeek.notice.binary', 'Binary file, no preview.')
    case 'too-large':
      return translate('terminal.filePeek.notice.tooLarge', 'This file is too large to preview.')
    case 'line-out-of-range':
      return translate(
        'terminal.filePeek.notice.lineOutOfRange',
        'The referenced line is past the end of the file.'
      )
    case 'unreadable':
      return translate('terminal.filePeek.notice.unreadable', "This file can't be read.")
    case 'unsupported':
      return translate('terminal.filePeek.notice.unsupported', 'No preview for this kind of file.')
  }
}

function PeekNotice({ reason }: { reason: NoticeReason }): React.JSX.Element {
  return <p className="py-0.5 text-muted-foreground">{noticeText(reason)}</p>
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label={translate('terminal.filePeek.loading', 'Loading preview')}
      className="space-y-1.5 py-1"
    >
      {LOADING_BAR_WIDTHS.map((width) => (
        <div
          key={width}
          className={cn('h-2.5 rounded-sm bg-foreground/10 motion-safe:animate-pulse', width)}
        />
      ))}
    </div>
  )
}

function DirectoryEntries({
  content
}: {
  content: Extract<TerminalFilePeekContent, { kind: 'directory' }>
}): React.JSX.Element {
  if (content.entries.length === 0) {
    return (
      <p className="py-0.5 text-muted-foreground">
        {translate('terminal.filePeek.emptyDirectory', 'This folder is empty.')}
      </p>
    )
  }
  return (
    <>
      <TerminalFilePeekBodyScroll>
        <ul>
          {content.entries.map((entry) => (
            <li key={entry.name} className="flex h-5 items-center gap-1.5">
              {entry.isDirectory ? (
                <FolderIcon
                  folderPath={entry.name}
                  open={false}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ) : (
                <FileTypeIcon
                  filePath={entry.name}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
              {entry.isSymlink ? (
                <>
                  <Link aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                  <span className="sr-only">
                    {translate('terminal.filePeek.symlink', 'Symbolic link')}
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </TerminalFilePeekBodyScroll>
      {content.hasMore ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {translate('terminal.filePeek.moreEntries', 'More entries are not shown.')}
        </p>
      ) : null}
    </>
  )
}

function PeekedContent({
  content,
  fileContext
}: {
  content: TerminalFilePeekContent
  fileContext: TerminalFileContext
}): React.JSX.Element {
  switch (content.kind) {
    case 'text':
      return <TerminalFilePeekBodyText content={content} />
    case 'image':
      return (
        <TerminalFilePeekBodyImage
          content={content}
          fileContext={fileContext}
          unreadableNotice={<PeekNotice reason="unreadable" />}
        />
      )
    case 'markdown':
      return (
        <TerminalFilePeekBodyScroll>
          <CommentMarkdown
            content={content.source}
            variant="compact"
            growing
            renderMermaid={false}
            extension={TERMINAL_FILE_PEEK_MARKDOWN_EXTENSION}
            className={MARKDOWN_CLASS}
          />
        </TerminalFilePeekBodyScroll>
      )
    case 'directory':
      return <DirectoryEntries content={content} />
    case 'notice':
      return <PeekNotice reason={content.reason} />
  }
}

/**
 * The preview section of the link action popover, placed between its path header and its action
 * rows: the rows sit at the end nearest the link, so they stay put while this section loads.
 */
export function TerminalFilePeekBody({
  content,
  fileContext
}: {
  content: TerminalFilePeekContent | 'loading'
  fileContext: TerminalFileContext
}): React.JSX.Element {
  return (
    <div
      data-slot="terminal-file-peek-body"
      className="mb-0.5 w-full max-w-full min-w-0 border-b border-border px-1.5 pt-1 pb-1.5 text-xs"
    >
      {content === 'loading' ? (
        <LoadingSkeleton />
      ) : (
        <PeekedContent content={content} fileContext={fileContext} />
      )}
    </div>
  )
}
