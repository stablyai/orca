import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { aiVaultAgentLabel, type AiVaultSession } from '../../../../shared/ai-vault-types'
import { conversationRoleLabel } from '../right-sidebar/ai-vault-session-row-display'
import { sessionDetailConversationTurns } from '../right-sidebar/ai-vault-session-display'

/** How many preview turns the fallback shows: enough to identify the conversation, few
 *  enough that the reader knows they are looking at an excerpt, not a transcript. */
const UNSUPPORTED_TURN_LIMIT = 12

/**
 * The transcript decoders cover a fixed roster of agents. For anything else the board
 * cannot show the real conversation, so it says so plainly and falls back to the bounded
 * preview the scan already carried — never a blank panel that reads as an empty session.
 */
export function SessionsConversationUnsupported({
  session
}: {
  session: AiVaultSession
}): React.JSX.Element {
  const turns = sessionDetailConversationTurns(session, UNSUPPORTED_TURN_LIMIT)
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <p className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {translate(
          'sessionsBoard.unsupported.notice',
          'Orca cannot decode {{agent}} transcripts yet, so this is the preview captured during the scan, not the full conversation.',
          { agent: aiVaultAgentLabel(session.agent) }
        )}
      </p>

      {turns.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          {translate('sessionsBoard.unsupported.noPreview', 'No conversation preview available.')}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {turns.map((turn) => (
            <div
              key={`${turn.role}:${turn.timestamp ?? ''}:${turn.text}`}
              className={cn(
                'rounded-md border px-2.5 py-2',
                turn.role === 'user'
                  ? 'border-border/70 bg-foreground/[0.04]'
                  : 'border-border/70 bg-muted/30'
              )}
            >
              <div className="mb-1 text-3xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {conversationRoleLabel(turn.role)}
              </div>
              <p className="select-text text-xs leading-snug text-foreground/90 [overflow-wrap:anywhere]">
                {turn.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Why: the preview window is the newest N messages, so a long session's first turn
          here is NOT the opening ask — saying so prevents a wrong reading of the excerpt. */}
      {session.previewMessagesTruncated ? (
        <p className="px-1 text-2xs text-muted-foreground/80">
          {translate(
            'sessionsBoard.unsupported.truncated',
            'Older messages fell outside the scan preview window and are not shown.'
          )}
        </p>
      ) : null}
    </div>
  )
}
