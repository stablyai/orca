import { agentSessionGoalControlWords } from './agent-session-goal-control-words'
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
  type AgentSessionHostStatusPresentation
} from '../../../../shared/agent-session-host-status-rows'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeLook
} from '../../../../shared/native-chat-notice'
import { useNativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { NativeChatInterruptedContinueButton } from './NativeChatInterruptedContinue'
import { nativeChatOrcaStopRowText } from './native-chat-orca-stop-words'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import { Button } from '@/components/ui/button'
import {
  isClaudeSignInFailureKind,
  nativeChatClaudeSignInLabel,
  useNativeChatClaudeSignInView
} from './native-chat-claude-sign-in'
import {
  agentSessionFailureDetailText,
  readWholeAgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../shared/agent-session-failure-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { nativeChatAntigravitySignInContent } from './native-chat-antigravity-settings'
import { formatUsageLimitResetClock } from '../../../../shared/agent-session-usage-limit'

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
    ),
  'continued-outside': () =>
    translate(
      'components.native-chat.notices.continuedOutside',
      HOST_STATUS_COPY['continued-outside']
    ),
  'continued-outside-rewound': () =>
    translate(
      'components.native-chat.notices.continuedOutsideRewound',
      HOST_STATUS_COPY['continued-outside-rewound']
    )
}

export function NativeChatNoticeRow({
  block,
  messageId,
  agentName,
  onLinkClick,
  allowFileUriLinks = false
}: {
  block: NativeChatTextBlock
  /** The transcript row's message, so a plan's code blocks keep their wrap past the row's mount. */
  messageId?: string
  agentName?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  useTranslation()
  const orcaStopView = useNativeChatOrcaStopView()
  const claudeSignIn = useNativeChatClaudeSignInView()
  const look = nativeChatNoticeLook(block)
  if (look.kind === 'divider') {
    const label =
      look.label === 'contextCleared'
        ? translate(
            'components.native-chat.notices.contextCleared',
            NATIVE_CHAT_NOTICE_COPY.contextCleared
          )
        : translate('components.native-chat.notices.compaction', NATIVE_CHAT_NOTICE_COPY.compaction)
    return (
      <div
        role="separator"
        aria-label={label}
        className="flex items-center gap-3 py-2 text-xs text-chat-foreground-faint"
      >
        <span className="h-px flex-1 bg-border" />
        <span>{label}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (look.kind === 'command-output') {
    // Why: command output is laid out in columns; proportional type breaks its grid.
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-chat-foreground">
        {block.text}
      </pre>
    )
  }
  if (look.kind === 'host-status') {
    // The look of any other host status line; only the words are the reader's.
    return (
      <p className="min-w-0 max-w-full select-text text-sm text-chat-foreground-faint [overflow-wrap:anywhere]">
        {HOST_STATUS_WORDS[look.presentation]()}
      </p>
    )
  }
  if (look.kind === 'plan') {
    return (
      <Card className="gap-3 py-3 shadow-xs">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">
            {translate('components.native-chat.notices.plan', NATIVE_CHAT_NOTICE_COPY.plan)}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm leading-relaxed text-foreground">
          <NativeChatMarkdown
            rowKey={messageId === undefined ? undefined : `plan:${messageId}`}
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
  // Name Orca and its host as the stop cause; without host context, preserve the original words.
  const { orcaStop } = block
  const { hostLabel, remoteHost, continueAvailable } = orcaStopView
  // A paired server with no name to show is still a remote server; its id is not a name.
  const machine =
    hostLabel ??
    (remoteHost
      ? translate('components.native-chat.notices.orcaStopUnnamedServer', 'the remote server')
      : null)
  const named = orcaStop !== undefined && machine !== null
  const continueOffered =
    orcaStop?.turnItemId !== undefined && orcaStop.turnItemId === orcaStopView.offeredTurnItemId
  const failure = readWholeAgentSessionFailureFact(block.failure)
  const antigravitySignInContent = nativeChatAntigravitySignInContent(failure?.kind, agentName)
  // Only reword auth text fully described by its fact; host text may also carry command advice.
  const authSurface =
    failure?.kind === 'notSignedIn'
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  const text = named
    ? nativeChatOrcaStopRowText(orcaStop.cause, machine, { continueAvailable, remoteHost })
    : failure?.kind === 'usageLimitReached'
      ? agentSessionFailureSentence(
          failure,
          'row',
          {
            agentName,
            usageLimitReset: formatUsageLimitResetClock
          },
          sayAgentSessionFailureTranslated
        )
      : failure && authSurface
        ? agentSessionFailureSentence(
            failure,
            authSurface,
            { agentName },
            sayAgentSessionFailureTranslated
          )
        : agentSessionGoalControlWords(block.text)
  const failureDetail = agentSessionFailureDetailText(failure)
  const detail = failureDetail?.trim() !== text.trim() ? failureDetail : undefined
  const tone = named ? 'notice' : look.kind === 'line' ? look.tone : null
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
        'space-y-2 text-sm text-chat-foreground',
        Icon && 'rounded-md border border-border bg-muted/20 p-3',
        tone === 'warning' && 'text-chat-warning',
        tone === 'error' && 'text-destructive',
        tone === 'notice' && 'text-chat-foreground-faint'
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {antigravitySignInContent ?? text}
        </p>
        {continueOffered ? (
          <NativeChatInterruptedContinueButton onContinue={orcaStopView.continueNow} />
        ) : null}
      </div>
      {claudeSignIn && isClaudeSignInFailureKind(block.failure?.kind) ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={claudeSignIn.signingIn}
          onClick={claudeSignIn.signIn}
        >
          {nativeChatClaudeSignInLabel(claudeSignIn)}
        </Button>
      ) : null}
      {block.providerFrame || detail ? (
        <ProviderFrameRow
          block={block}
          detail={detail}
          summary={translate('components.native-chat.notices.details', 'Details')}
        />
      ) : null}
    </div>
  )
}
