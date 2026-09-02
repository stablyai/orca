import React, { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'

const ANNOUNCE_DEBOUNCE_MS = 400
// Why: the counter overlays the input, so its width has to be reserved rather
// than guessed — a fixed reserve overlaps typed text once counts reach 3 digits.
// `ch` keeps that reserve font-relative across platforms: it measures the input's
// own 12px font while the counter renders at 10px tabular-nums, so digits always
// over-reserve and '/' and ' ' are narrower still.
const CLEAR_BUTTON_RESERVE_PX = 32
const OVERLAY_GAP_PX = 4
// Why: a wide counter in a narrow drawer could otherwise reserve the whole
// field and squeeze the typed text to nothing. Overlapping the counter is the
// better failure at that size.
const MAX_OVERLAY_RESERVE = '55%'

type WorkspaceKanbanSearchFieldProps = {
  query: string
  /** False for text that never narrows the board (whitespace-only, over-bound). */
  isFiltering: boolean
  /** True when the text was discarded for length, which needs saying out loud. */
  isTooLarge: boolean
  matchCount: number
  totalCount: number
  onQueryChange: (query: string) => void
  onClear: () => void
  /** Escape in an empty field has nothing local to cancel, so it dismisses the board. */
  onClose: () => void
}

/** Exported for test: happy-dom drops `min()`, so this cannot be read back off a style. */
export function overlayReserve(overlayText: string | null): string {
  if (!overlayText) {
    return `${CLEAR_BUTTON_RESERVE_PX}px`
  }
  return `min(calc(${CLEAR_BUTTON_RESERVE_PX + OVERLAY_GAP_PX}px + ${overlayText.length}ch), ${MAX_OVERLAY_RESERVE})`
}

function formatAnnouncement(matchCount: number, totalCount: number): string {
  return matchCount === 0
    ? translate(
        'auto.components.sidebar.WorkspaceKanbanSearchField.bdb753c78d',
        'No workspaces match'
      )
    : translate(
        'auto.components.sidebar.WorkspaceKanbanSearchField.4d96c209d6',
        '{{value0}} of {{value1}} workspaces match',
        { value0: matchCount, value1: totalCount }
      )
}

export default function WorkspaceKanbanSearchField({
  query,
  isFiltering,
  isTooLarge,
  matchCount,
  totalCount,
  onQueryChange,
  onClear,
  onClose
}: WorkspaceKanbanSearchFieldProps): React.JSX.Element {
  const hasText = query !== ''
  const counterText = isFiltering ? `${matchCount} / ${totalCount}` : null
  const inputRef = useRef<HTMLInputElement>(null)
  const [announcement, setAnnouncement] = useState('')

  const tooLargeMessage = isTooLarge
    ? translate(
        'auto.components.sidebar.WorkspaceKanbanSearchField.7f1c2e94a5',
        'Search text is too long — the board is unfiltered'
      )
    : null
  const tooLargeLabel = isTooLarge
    ? translate('auto.components.sidebar.WorkspaceKanbanSearchField.9a4d0f6b21', 'Too long')
    : null
  const badgeText = tooLargeLabel ?? counterText

  // Why: the filter itself is undebounced, but a polite live region that changes
  // on every keystroke produces continuous speech and makes the field unusable.
  useEffect(() => {
    if (tooLargeMessage) {
      setAnnouncement(tooLargeMessage)
      return
    }
    if (!isFiltering) {
      setAnnouncement('')
      return
    }
    const timer = window.setTimeout(
      () => setAnnouncement(formatAnnouncement(matchCount, totalCount)),
      ANNOUNCE_DEBOUNCE_MS
    )
    return () => window.clearTimeout(timer)
  }, [isFiltering, matchCount, totalCount, tooLargeMessage])

  return (
    <div className="relative flex min-w-0 max-w-xs flex-1 items-center">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        aria-label={translate(
          'auto.components.sidebar.WorkspaceKanbanSearchField.c0cd6bdf6c',
          'Search workspaces'
        )}
        placeholder={translate(
          'auto.components.sidebar.WorkspaceKanbanSearchField.c0cd6bdf6c',
          'Search workspaces'
        )}
        aria-invalid={isTooLarge || undefined}
        className="h-7 border-worktree-sidebar-border bg-background pl-7 text-xs"
        style={hasText ? { paddingRight: overlayReserve(badgeText) } : undefined}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // Why: useWorkspaceBoardPanel defers Escape to board text fields, so
          // this field is the only handler — it must cover both outcomes.
          // Mid-composition Escape belongs to the IME, which cancels the
          // in-progress reading rather than the query behind it.
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) {
            return
          }
          event.preventDefault()
          if (hasText) {
            onClear()
            return
          }
          onClose()
        }}
      />
      {hasText ? (
        <div className="absolute right-1 flex items-center gap-0.5">
          {/* Why: a discarded query looks exactly like one that matched
              everything, so the field has to say which it was. */}
          {tooLargeLabel ? (
            <span
              aria-hidden="true"
              title={tooLargeMessage ?? undefined}
              className="text-[10px] text-destructive"
            >
              {tooLargeLabel}
            </span>
          ) : counterText ? (
            <span aria-hidden="true" className="text-[10px] tabular-nums text-muted-foreground">
              {counterText}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.sidebar.WorkspaceKanbanSearchField.3b7ea51793',
              'Clear search'
            )}
            // Why: clearing unmounts this button, so focus would fall to
            // <body>. Keep it in the field the user is still typing in.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              onClear()
              inputRef.current?.focus()
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
