import type React from 'react'
import { Archive } from 'lucide-react'
import {
  aiVaultSessionRecoverableSignalCount,
  isAiVaultSessionRecoverableEmpty,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'

// Distinct state for a zero-turn transcript: the conversation was not persisted,
// but queued prompts and/or subagent transcripts may still be recoverable.
export function SessionUnsavedConversationNotice({
  session,
  logAvailable
}: {
  session: AiVaultSession
  // Whether an open-log affordance exists nearby; remote (SSH) sessions have
  // none, so the "open the log" hint would point at nothing.
  logAvailable: boolean
}): React.JSX.Element {
  const recoverable = isAiVaultSessionRecoverableEmpty(session)

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        <Archive className="size-3 text-muted-foreground/80" />
        <span>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.conversationNotSaved',
            'Conversation not saved'
          )}
        </span>
      </div>
      <div className="rounded-md border border-dashed border-border/70 bg-foreground/[0.04] px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {recoverable
          ? translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.recoverableEmptyDetail',
              'This session has no saved conversation, but {{value0}} recoverable item(s) survive.',
              { value0: aiVaultSessionRecoverableSignalCount(session) }
            )
          : translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.emptyConversationDetail',
              'This session has no saved conversation and cannot be resumed.'
            )}
        {recoverable && logAvailable
          ? ` ${translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.recoverableEmptyOpenLogHint',
              'Open the log to recover them.'
            )}`
          : null}
        {recoverable ? (
          <SessionRecoverableSignalLines
            queuedMessageCount={session.queuedMessageCount}
            subagentTranscriptCount={session.subagentTranscriptCount}
          />
        ) : null}
      </div>
    </section>
  )
}

function SessionRecoverableSignalLines({
  queuedMessageCount,
  subagentTranscriptCount
}: {
  queuedMessageCount: number
  subagentTranscriptCount: number
}): React.JSX.Element {
  return (
    <ul className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-foreground/80">
      {queuedMessageCount > 0 ? (
        <li>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.queuedMessages',
            '{{value0}} queued message(s)',
            { value0: queuedMessageCount }
          )}
        </li>
      ) : null}
      {subagentTranscriptCount > 0 ? (
        <li>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.subagentTranscripts',
            '{{value0}} subagent transcript(s)',
            { value0: subagentTranscriptCount }
          )}
        </li>
      ) : null}
    </ul>
  )
}
