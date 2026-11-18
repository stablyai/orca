import { useState } from 'react'
import {
  ArrowLeft,
  AtSign,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  AlertTriangle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  AgentSessionSwarmTranscriptResult,
  AntigravitySwarmMember,
  AntigravitySwarmMemberTranscriptEntry
} from '../../../../../shared/agent-session/antigravity-swarm-wire'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'

function pathTail(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? filePath
}

function SwarmMemberTranscriptRow({
  entry
}: {
  entry: AntigravitySwarmMemberTranscriptEntry
}): React.JSX.Element {
  const t = useTranslate()
  const [thinkingOpen, setThinkingOpen] = useState(false)

  if (entry.kind === 'user') {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
        <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground">
          <span className="font-medium uppercase tracking-wider">
            {t('components.native-chat.swarm.promptLabel', 'Prompt')}
          </span>
          <span>#{entry.stepIndex}</span>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {entry.text}
        </div>
      </div>
    )
  }

  if (entry.kind === 'error') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{t('components.native-chat.swarm.stepError', 'Step failed')}</span>
          <span className="ml-auto text-2xs">#{entry.stepIndex}</span>
        </div>
        <p className="whitespace-pre-wrap leading-relaxed">{entry.text}</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-background/60 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-2xs text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">
          {t('components.native-chat.swarm.assistantLabel', 'Response')}
        </span>
        <span>#{entry.stepIndex}</span>
      </div>
      {entry.thinking ? (
        <div className="mb-2">
          <button
            type="button"
            aria-expanded={thinkingOpen}
            onClick={() => setThinkingOpen((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {thinkingOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
            <span>{t('components.native-chat.swarm.thinking', 'Thinking')}</span>
          </button>
          {thinkingOpen ? (
            <div className="mt-1 rounded border border-border bg-muted/30 p-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {entry.thinking}
            </div>
          ) : null}
        </div>
      ) : null}
      {entry.toolCalls.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {entry.toolCalls.map((call, idx) => (
            <span
              key={`${entry.stepIndex}-tool-${idx}`}
              className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
              title={call.name}
            >
              {call.label || call.name}
            </span>
          ))}
        </div>
      ) : null}
      {entry.text ? (
        <NativeChatMarkdown
          content={entry.text}
          variant="document"
          linkifyFilePaths
          rowKey={`swarm-member-${entry.stepIndex}`}
          className="text-sm leading-relaxed text-foreground"
        />
      ) : null}
    </div>
  )
}

export function NativeChatSwarmMemberTranscript({
  member,
  transcript,
  loading,
  canMention,
  onBack,
  onRefresh,
  onMention
}: {
  member: AntigravitySwarmMember
  transcript: AgentSessionSwarmTranscriptResult | null
  loading: boolean
  canMention: boolean
  onBack: () => void
  onRefresh: () => void
  onMention: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeft className="size-3.5" />
          <span>{t('components.native-chat.swarm.backToBoard', 'Board')}</span>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{member.name}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-3xs uppercase tracking-wider text-muted-foreground">
            {member.role}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
            {member.status}
          </span>
          {member.model ? (
            <span className="truncate text-2xs text-muted-foreground" title={member.model}>
              {member.model}
            </span>
          ) : null}
          {member.worktree ? (
            <span
              className="truncate font-mono text-2xs text-muted-foreground"
              title={member.worktree}
            >
              {pathTail(member.worktree)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {canMention ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => onMention(member.name)}
              title={t('components.native-chat.swarm.mentionMember', 'Mention @{{name}}', {
                name: member.name
              })}
            >
              <AtSign className="size-3" />
              <span>{member.name}</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onRefresh}
            aria-label={t('components.native-chat.swarm.refreshTranscript', 'Refresh transcript')}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {member.failure ? (
        <div className="flex items-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={member.failure.text}>
            {member.failure.text}
          </span>
        </div>
      ) : null}

      <div className="scrollbar-sleek min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {loading && (!transcript || transcript.status !== 'ok') ? (
          <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
            <LoadingSpinner className="size-3.5" />
            <span>
              {t('components.native-chat.swarm.loadingTranscript', 'Loading worker conversation…')}
            </span>
          </div>
        ) : transcript?.status === 'failed' ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            {transcript.message ??
              t(
                'components.native-chat.swarm.transcriptFailed',
                'Could not read worker transcript.'
              )}
          </div>
        ) : transcript?.status === 'ok' && transcript.entries.length > 0 ? (
          <>
            {transcript.truncated ? (
              <p className="text-center text-2xs text-muted-foreground">
                {t(
                  'components.native-chat.swarm.earlierStepsTrimmed',
                  'Showing the most recent conversation steps'
                )}
              </p>
            ) : null}
            {transcript.entries.map((entry) => (
              <SwarmMemberTranscriptRow
                key={`${member.conversationId}-${entry.stepIndex}-${entry.kind}`}
                entry={entry}
              />
            ))}
          </>
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('components.native-chat.swarm.noTranscriptYet', 'No worker messages recorded yet.')}
          </p>
        )}
      </div>
    </div>
  )
}
