import { LoaderCircle } from 'lucide-react'

import { OdooUserAvatar } from '@/components/odoo-user-avatar'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { OdooMentionSuggestion } from '../../../shared/odoo-types'
/**
 * Floating `@` mention picker anchored above the composer textarea. Follows the
 * hand-rolled inline-suggestion pattern used for GitHub @mentions in
 * PullRequestPage.tsx rather than Command/Popover, since this triggers from
 * free-typed text at the caret, not a click-revealed control.
 */
export function OdooTicketMentionSuggestions({
  suggestions,
  activeIndex,
  loading,
  onChoose
}: {
  suggestions: OdooMentionSuggestion[]
  activeIndex: number
  loading: boolean
  onChoose: (candidate: OdooMentionSuggestion) => void
}): React.JSX.Element {
  return (
    <div
      role="listbox"
      className="scrollbar-sleek absolute bottom-full left-0 right-0 z-20 mb-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
    >
      {loading && suggestions.length === 0 ? (
        <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {translate(
            'auto.components.odoo.ticket.mention.suggestions.bddabd09c6',
            'Searching people…'
          )}
        </div>
      ) : null}
      {!loading && suggestions.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {translate(
            'auto.components.odoo.ticket.mention.suggestions.43bd769377',
            'No matching person'
          )}
        </div>
      ) : null}
      {suggestions.map((candidate, index) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          // Why: the textarea owns caret/query state, so accept the pick before
          // the browser moves focus away from it on click.
          onMouseDown={(event) => {
            event.preventDefault()
            onChoose(candidate)
          }}
          className={cn(
            'flex w-full items-center gap-2 rounded-sm border border-transparent px-2 py-1.5 text-left text-xs',
            index === activeIndex
              ? 'border-border bg-accent text-accent-foreground'
              : 'hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <OdooUserAvatar
            user={{ displayName: candidate.name, avatarUrl: candidate.avatarUrl }}
            className="size-5"
          />
          <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
          {candidate.login ? (
            <span className="shrink-0 truncate text-[11px] text-muted-foreground">
              {candidate.login}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
