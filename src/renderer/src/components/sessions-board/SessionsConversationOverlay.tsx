import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, GitBranch, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { aiVaultAgentLabel, type AiVaultSession } from '../../../../shared/ai-vault-types'
import { sessionModelLabel } from '../right-sidebar/ai-vault-session-display'
import { useAiVaultSessionDisplayTitle } from '../right-sidebar/use-ai-vault-session-display-title'
import type { NativeChatLiveSession } from '../native-chat/native-chat-live-session-contract'
import { SessionsBoardSessionActions } from './SessionsBoardSessionActions'
import type { SessionsBoardCardAvailability } from './sessions-board-card-availability'
import { SessionsConversationTranscript } from './SessionsConversationTranscript'
import { SessionsConversationUnsupported } from './SessionsConversationUnsupported'
import { useReadOnlyNativeChat, type SessionsConversationPhase } from './use-read-only-native-chat'

/**
 * A conversation the board opened: everything the board already knows about the session,
 * plus its transcript when Orca can decode it. Non-modal on purpose — the terminal keeps
 * its shortcuts and Escape keeps its meaning (the page closes this, then itself).
 */
export function SessionsConversationOverlay({
  session,
  availability,
  onClose,
  onCopy,
  onJump,
  onResume
}: {
  session: AiVaultSession
  availability: SessionsBoardCardAvailability | null
  onClose: () => void
  onCopy: (text: string) => void
  onJump: () => void
  onResume: () => void
}): React.JSX.Element {
  const title = useAiVaultSessionDisplayTitle(session)
  const { phase, error, transcript, retry } = useReadOnlyNativeChat(session)
  const updatedAt = session.updatedAt ?? session.modifiedAt

  return (
    <div
      role="dialog"
      aria-label={translate('sessionsBoard.conversation.ariaLabel', 'Read-only conversation')}
      data-testid="sessions-conversation-overlay"
      className="absolute inset-0 z-20 flex flex-col bg-background"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2.5">
        <AgentIcon agent={session.agent} size={16} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium leading-5">
            {title || translate('sessionsBoard.card.untitled', 'Untitled session')}
          </h2>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
            <span className="shrink-0">{aiVaultAgentLabel(session.agent)}</span>
            <span className="shrink-0 text-muted-foreground/55">·</span>
            <span className="shrink-0 tabular-nums">
              {translate('sessionsBoard.card.messageCount', '{{count}} msgs', {
                count: session.messageCount
              })}
            </span>
            <span className="shrink-0 text-muted-foreground/55">·</span>
            <span className="shrink-0">{formatUiRelativeTimeFromDate(updatedAt)}</span>
            {session.model ? (
              <>
                <span className="shrink-0 text-muted-foreground/55">·</span>
                <span className="min-w-0 truncate">{sessionModelLabel(session)}</span>
              </>
            ) : null}
            {session.branch ? (
              <>
                <span className="shrink-0 text-muted-foreground/55">·</span>
                <span className="flex min-w-0 items-center gap-1">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{session.branch}</span>
                </span>
              </>
            ) : null}
            {session.cwd ? (
              <>
                <span className="shrink-0 text-muted-foreground/55">·</span>
                <span className="min-w-0 truncate" title={session.cwd}>
                  {session.cwd}
                </span>
              </>
            ) : null}
          </div>
        </div>
        {/* Why the actions live here too: this is where a card click lands, and deciding to
            pick the session back up is the natural next thought after reading it. */}
        <span className="flex shrink-0 items-center gap-0.5">
          <SessionsBoardSessionActions
            availability={availability}
            onJump={onJump}
            onResume={onResume}
          />
        </span>
        <InlineCopyButton text={session.resumeCommand} onCopy={onCopy} />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={translate('sessionsBoard.conversation.close', 'Close conversation')}
        >
          <X className="size-4" />
        </Button>
      </header>

      <ConversationBody
        phase={phase}
        transcript={transcript}
        error={error}
        session={session}
        onRetry={retry}
        onCopy={onCopy}
      />
    </div>
  )
}

/** Early returns, so each phase narrows instead of surviving as a widened union. */
function ConversationBody({
  phase,
  transcript,
  error,
  session,
  onRetry,
  onCopy
}: {
  phase: SessionsConversationPhase
  transcript: NativeChatLiveSession | null
  error: string | null
  session: AiVaultSession
  onRetry: () => void
  onCopy: (text: string) => void
}): React.JSX.Element {
  if (phase === 'unsupported') {
    return <SessionsConversationUnsupported session={session} />
  }
  if (phase === 'ready' && transcript) {
    return <SessionsConversationTranscript session={transcript} />
  }
  const copyPath = (): void => onCopy(session.filePath)
  if (phase === 'notWritten' || phase === 'error') {
    return <ConversationState phase={phase} error={error} onRetry={onRetry} onCopyPath={copyPath} />
  }
  // 'loading', and the settled-but-unrendered case the adapter never produces.
  return <ConversationState phase="loading" error={null} onRetry={onRetry} onCopyPath={copyPath} />
}

function ConversationState({
  phase,
  error,
  onRetry,
  onCopyPath
}: {
  phase: 'loading' | 'notWritten' | 'error'
  error: string | null
  onRetry: () => void
  onCopyPath: () => void
}): React.JSX.Element {
  if (phase === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {translate('sessionsBoard.conversation.loading', 'Reading transcript…')}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-md text-xs leading-5 text-muted-foreground">
        {phase === 'notWritten'
          ? translate(
              'sessionsBoard.conversation.notWritten',
              'This conversation has not been written to disk yet. Retry once the agent has finished a turn.'
            )
          : error ||
            translate('sessionsBoard.conversation.failed', 'The transcript failed to load.')}
      </p>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {translate('sessionsBoard.conversation.retry', 'Retry')}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCopyPath}>
          {translate('sessionsBoard.conversation.copyPath', 'Copy transcript path')}
        </Button>
      </div>
    </div>
  )
}

/** Hidden when there is nothing to copy — a resume command is absent for some agents. */
function InlineCopyButton({
  text,
  onCopy
}: {
  text: string
  onCopy: (text: string) => void
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
      }
    }
  }, [])

  const handleCopy = useCallback((): void => {
    onCopy(text)
    setCopied(true)
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setCopied(false)
    }, 1500)
  }, [text, onCopy])

  if (!text) {
    return null
  }
  const label = copied
    ? translate('sessionsBoard.card.copied', 'Copied')
    : translate('sessionsBoard.card.copyResume', 'Copy resume command')
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  )
}
