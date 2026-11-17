import type { ReactNode } from 'react'
import { FileTypeIcon } from '@/components/FileTypeIcon'
import { cn } from '@/lib/class-names'
import { ChangedFileOpenIcon, type FileOpenGlyph } from '@/lib/files/open/ChangedFileOpenIcon'

/** The card's single open target; the trailing glyph only names where it goes. */
export type NativeChatFileCardAction = {
  label: string
  tooltip: string
  glyph: FileOpenGlyph
  onOpen: () => void
}

/**
 * One file a chat message carries: a type badge, its name, a meta line and where it opens. `row` is the
 * dense turn-summary line; `card` is the two-line attachment card. Without an action it is inert.
 */
export function NativeChatFileCard({
  variant,
  path,
  name,
  detail,
  meta,
  action
}: {
  variant: 'row' | 'card'
  path: string
  name: string
  /** The directory shown after the name in a row. */
  detail?: string
  meta: ReactNode
  action: NativeChatFileCardAction | null
}): React.JSX.Element {
  const row = variant === 'row'
  const content = (
    <>
      <span
        className={cn(
          'flex shrink-0 items-center justify-center bg-chat-code-surface',
          row ? 'size-5 rounded' : 'size-8 rounded-md'
        )}
      >
        <FileTypeIcon filePath={path} className={row ? 'size-3.5' : 'size-4'} />
      </span>
      {row ? (
        <>
          {/* The directory gives way first, then the name; meta and glyph always stay whole. */}
          <span className="max-w-[45%] min-w-0 truncate font-mono text-chat-foreground">
            {name}
          </span>
          <span className="min-w-0 flex-1 truncate text-right font-mono">{detail}</span>
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">{meta}</span>
        </>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-chat-foreground">{name}</span>
          <span className="truncate text-xs">{meta}</span>
        </span>
      )}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {action ? <ChangedFileOpenIcon target={action.glyph} className="size-3.5" /> : null}
      </span>
    </>
  )
  const className = cn(
    'flex min-w-0 items-center text-left text-xs text-chat-foreground-faint',
    row
      ? 'h-6 flex-1 gap-2 rounded-md px-1.5'
      : 'max-w-72 gap-2.5 rounded-lg border border-chat-code-border px-2.5 py-2'
  )
  if (!action) {
    return (
      <div className={className} aria-disabled title={path}>
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn(
        className,
        'cursor-pointer hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      aria-label={`${action.label}: ${path}`}
      title={action.tooltip}
      onClick={action.onOpen}
    >
      {content}
    </button>
  )
}

/** The uppercased extension (`MD`, `HTML`), or `FILE` when there is none. */
export function nativeChatFileType(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : 'FILE'
}
