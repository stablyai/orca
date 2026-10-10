import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  AGENT_SESSION_HOST_STATUS_COPY as HOST_STATUS_COPY,
  isAgentSessionHostStatusPresentation,
  type AgentSessionHostStatusPresentation
} from '../../../../shared/agent-session-host-status-rows'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import { useNativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { nativeChatOrcaStopRowText } from './native-chat-orca-stop-words'
import { AGENT_SESSION_ORCA_STOP_PRESENTATION } from '../../../../shared/agent-session-orca-stop'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import { readWholeAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'

const HOST_STATUS_WORDS: Record<AgentSessionHostStatusPresentation, () => string> = {
  'history-repaired': () =>
    translate(
      'components.native-chat.notices.historyRepaired',
      HOST_STATUS_COPY['history-repaired']
    ),
  'history-item-too-large': () =>
    translate(
      'components.native-chat.notices.historyItemTooLarge',
      HOST_STATUS_COPY['history-item-too-large']
    )
}

export function NativeChatNoticeRow({
  block,
  agentName,
  onLinkClick,
  allowFileUriLinks = false
}: {
  block: NativeChatTextBlock
  agentName?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  useTranslation()
  const orcaStopView = useNativeChatOrcaStopView()
  if (block.presentation === 'compaction' || block.presentation === 'context-cleared') {
    const label =
      block.presentation === 'context-cleared'
        ? translate('components.native-chat.notices.contextCleared', 'Context cleared')
        : translate('components.native-chat.notices.compaction', 'Context compacted')
    return (
      <div
        role="separator"
        aria-label={label}
        className="flex items-center gap-3 py-2 text-xs text-muted-foreground"
      >
        <span className="h-px flex-1 bg-border" />
        <span>{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (block.presentation === 'command-output') {
    // Why: command output is laid out in columns; proportional type breaks its grid.
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
        {block.text}
      </pre>
    )
  }
  if (isAgentSessionHostStatusPresentation(block.presentation)) {
    // The look of any other host status line; only the words are the reader's.
    return (
      <p className="min-w-0 max-w-full select-text text-sm text-muted-foreground [overflow-wrap:anywhere]">
        {HOST_STATUS_WORDS[block.presentation]()}
      </p>
    )
  }
  if (block.presentation === 'plan-document') {
    return (
      <Card className="gap-3 py-3 shadow-xs">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">
            {translate('components.native-chat.notices.plan', 'Plan')}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm leading-relaxed text-foreground">
          <NativeChatMarkdown
            content={block.text}
            variant="document"
            renderCodeBlock={NativeChatCodeBlock}
            className="text-sm text-chat-foreground"
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            linkifyFilePaths={onLinkClick !== undefined}
          />
        </CardContent>
      </Card>
    )
  }
  // The host's row about an Orca stop names the cause and the machine, muted: Orca stopped, not the
  // agent. With no machine to name it keeps the host's own words.
  const { orcaStop } = block
  const { hostLabel, continueAvailable } = orcaStopView
  const named = orcaStop !== undefined && hostLabel !== null
  const failure = readWholeAgentSessionFailureFact(block.failure)
  // Only reword auth text fully described by its fact; host text may also carry command advice.
  const authSurface =
    failure?.kind === 'notSignedIn'
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  const text = named
    ? nativeChatOrcaStopRowText(orcaStop.cause, hostLabel, { continueAvailable })
    : failure && authSurface
      ? agentSessionFailureSentence(
          failure,
          authSurface,
          { agentName },
          sayAgentSessionFailureTranslated
        )
      : block.text
  const tone =
    named || block.presentation === AGENT_SESSION_ORCA_STOP_PRESENTATION ? 'notice' : block.tone
  const Icon =
    tone === 'warning'
      ? AlertTriangle
      : tone === 'error'
        ? AlertCircle
        : tone === 'notice'
          ? Info
          : null
  return (
    <div
      className={cn(
        'space-y-2 text-sm text-foreground',
        Icon && 'rounded-md border border-border bg-muted/20 p-3',
        tone === 'warning' && 'text-[color:var(--warning,#f59e0b)]',
        tone === 'error' && 'text-destructive',
        tone === 'notice' && 'text-muted-foreground'
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p className="min-w-0 whitespace-pre-wrap break-words">{text}</p>
      </div>
      {block.providerFrame ? (
        <ProviderFrameRow
          block={block}
          summary={translate('components.native-chat.notices.details', 'Details')}
        />
      ) : null}
    </div>
  )
}
