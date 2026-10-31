import type React from 'react'
import { Archive } from 'lucide-react'
import {
  aiVaultSessionRecoverableSignalCount,
  isAiVaultSessionRecoverableEmpty,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'

// Zero-turn transcripts may still have recoverable queued prompts or subagent history.
export function SessionUnsavedConversationNotice({
  session,
  logAvailable
}: {
  session: AiVaultSession
  // Show open-log guidance only when a nearby action exists; SSH sessions have none.
  logAvailable: boolean
}): React.JSX.Element {
  if (session.source === 'structured-record') {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.AiVaultSessionDetails.noPreviewAvailable',
          'No conversation preview available'
        )}
      </p>
    )
  }
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
              'auto.components.right.sidebar.AiVaultSessionDetails.recoverableEmptyDetailCount',
              'This session has no saved conversation, but {{count}} recoverable items survive.',
              {
                count: aiVaultSessionRecoverableSignalCount(session),
                defaultValue_one:
                  'This session has no saved conversation, but {{count}} recoverable item survives.'
              }
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
            'auto.components.right.sidebar.AiVaultSessionDetails.queuedMessageCount',
            '{{count}} queued messages',
            { count: queuedMessageCount, defaultValue_one: '{{count}} queued message' }
          )}
        </li>
      ) : null}
      {subagentTranscriptCount > 0 ? (
        <li>
          {translate(
            'auto.components.right.sidebar.AiVaultSessionDetails.subagentTranscriptCount',
            '{{count}} subagent transcripts',
            { count: subagentTranscriptCount, defaultValue_one: '{{count}} subagent transcript' }
          )}
        </li>
      ) : null}
    </ul>
  )
}
