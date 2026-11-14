import {
  CLAUDE_MODEL_FALLBACK_COPY,
  claudeModelFallbackLabels
} from '../../../../../../shared/native-chat/claude-model-fallback'
import { NativeChatUsageLimitAutoContinue } from '../../usage/NativeChatUsageLimitAutoContinue'
import { NativeChatUsageLimitActions } from '../../usage/NativeChatUsageLimitActions'
import { agentSessionGoalControlWords } from '../../session/goals/agent-session-goal-control-words'
import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useContext, useSyncExternalStore } from 'react'
import { NativeChatForkedFromContext } from '../actions/native-chat-fork-context'
import { NativeChatPullRequestEventLine } from './NativeChatPullRequestEventLine'
import { PULL_REQUEST_EVENT_PRESENTATION } from '../../../../../../shared/native-chat/native-chat-pull-request-event'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  AGENT_SESSION_HOST_STATUS_COPY as HOST_STATUS_COPY,
  type AgentSessionHostStatusPresentation
} from '../../../../../../shared/agent-session/view/agent-session-host-status-rows'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeLook,
  type NativeChatNoticeTone
} from '../../../../../../shared/native-chat/native-chat-notice'
import { useNativeChatOrcaStopView } from './native-chat-orca-stop-context'
import { NativeChatInterruptedContinueButton } from '../../usage/NativeChatInterruptedContinue'
import { nativeChatOrcaStopRowText } from '../../../../../../shared/native-chat/native-chat-orca-stop-words'
import { sayNativeChatOrcaStopTranslated } from './native-chat-orca-stop-words-text'
import {
  NativeChatDetailsDisclosure,
  ProviderFrameRow
} from '../diagnostics/NativeChatProviderDetails'
import { NativeChatSetupButton } from '../../host-access/NativeChatSetupButton'
import { agentSessionFailureDetailText } from '../../../../../../shared/agent-session/failures/agent-session-failure-quoted-detail'
import { readWholeAgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../../shared/agent-session/failures/agent-session-failure-words'
import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { nativeChatAntigravitySignInContent } from '../../host-access/native-chat-antigravity-settings'
import { NativeChatCollapsedNotice } from './NativeChatCollapsedNotice'
import { formatUsageLimitResetClock } from '../../../../../../shared/agent-session/failures/agent-session-usage-limit'

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

function toneClass(tone: NativeChatNoticeTone): string {
  return tone === 'warning'
    ? 'text-chat-warning'
    : tone === 'error'
      ? 'text-destructive'
      : 'text-chat-foreground-faint'
}

export function NativeChatNoticeRow({
  block,
  messageId,
  agentName,
  disclosureKeys
}: {
  block: NativeChatTextBlock
  /** The transcript row's message, so a plan's code blocks keep their wrap past the row's mount. */
  messageId?: string
  agentName?: string
  /** Where a collapsed notice's open choice is kept, newest first. */
  disclosureKeys?: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const orcaStopView = useNativeChatOrcaStopView()
  const openForkSource = useContext(NativeChatForkedFromContext)

  if (block.presentation === PULL_REQUEST_EVENT_PRESENTATION) {
    return <NativeChatPullRequestEventLine block={block} messageId={messageId} />
  }
  const look = nativeChatNoticeLook(block)
  if (look.kind === 'forked-from') {
    const label = t('components.native-chat.notices.forkedFrom', NATIVE_CHAT_NOTICE_COPY.forkedFrom)
    return (
      // Plain text with decorative rules: a separator role would hide the source button from screen readers.
      <div className="flex items-center gap-3 py-2 text-xs text-chat-foreground-faint">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span>
          {label}{' '}
          {openForkSource ? (
            <button
              type="button"
              className="rounded-sm underline underline-offset-2 hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => openForkSource(look.sourceSessionId)}
            >
              {look.sourceName}
            </button>
          ) : (
            look.sourceName
          )}
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
    )
  }
  if (look.kind === 'divider') {
    const label =
      look.label === 'contextCleared'
        ? t('components.native-chat.notices.contextCleared', NATIVE_CHAT_NOTICE_COPY.contextCleared)
        : t('components.native-chat.notices.compaction', NATIVE_CHAT_NOTICE_COPY.compaction)
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
  if (look.kind === 'model-fallback') {
    return (
      <p className="min-w-0 max-w-full select-text text-sm text-chat-foreground-faint [overflow-wrap:anywhere]">
        {t(
          'components.native-chat.notices.modelFallback',
          CLAUDE_MODEL_FALLBACK_COPY,
          claudeModelFallbackLabels(look)
        )}
      </p>
    )
  }
  if (look.kind === 'plan') {
    return (
      <Card className="gap-3 py-3 shadow-xs">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">
            {t('components.native-chat.notices.plan', NATIVE_CHAT_NOTICE_COPY.plan)}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 text-sm leading-relaxed text-foreground">
          <NativeChatMarkdown
            rowKey={messageId === undefined ? undefined : `plan:${messageId}`}
            content={block.text}
            variant="document"
            renderCodeBlock={NativeChatCodeBlock}
            className="text-sm text-chat-foreground"
            linkifyFilePaths
          />
        </CardContent>
      </Card>
    )
  }
  if (look.kind === 'settled-permission') {
    const agent = agentName ?? look.agent
    const summary =
      look.decision === 'approved'
        ? t(
            'components.native-chat.notices.safetyReviewApproved',
            '{{agent}} approved this action. View details.',
            { agent }
          )
        : look.decision === 'denied'
          ? t(
              'components.native-chat.notices.permissionDenied',
              '{{agent}} denied permission. View details.',
              { agent }
            )
          : t(
              'components.native-chat.notices.safetyReview',
              '{{agent}} reported a safety review warning. View details.',
              { agent }
            )
    const payload = block.providerFrame?.payload
    return (
      <NativeChatDetailsDisclosure summary={summary} bodyClassName={toneClass(look.tone)}>
        {block.text}
        {payload ? '\n\n' : ''}
        {payload?.truncated
          ? `${t(
              'components.native-chat.notices.truncatedResponse',
              'Provider response truncated (original size: {{bytes}} bytes).',
              { bytes: payload.byteLength }
            )}\n`
          : ''}
        {payload?.head}
      </NativeChatDetailsDisclosure>
    )
  }
  if (look.kind === 'collapsed-notice') {
    return <NativeChatCollapsedNotice block={block} look={look} disclosureKeys={disclosureKeys} />
  }
  // Name Orca and its host as the stop cause; without host context, preserve the original words.
  const { orcaStop } = block
  const { hostLabel, remoteHost, continueAvailable, wslDistro } = orcaStopView
  // A paired server with no name to show is still a remote server; its id is not a name.
  const machine =
    hostLabel ?? (remoteHost ? sayNativeChatOrcaStopTranslated('unnamedServer') : null)
  const named = orcaStop !== undefined && machine !== null
  const continueOffered =
    orcaStop?.turnItemId !== undefined && orcaStop.turnItemId === orcaStopView.offeredTurnItemId
  const failure = readWholeAgentSessionFailureFact(block.failure)
  const antigravitySignInContent = nativeChatAntigravitySignInContent(
    failure?.kind,
    agentName,
    failure?.account,
    t
  )
  const usageLimitContinue =
    block.usageLimitTurnItemId !== undefined &&
    block.usageLimitTurnItemId === orcaStopView.usageLimitTurnItemId
  // Reword only text fully described by its fact; other host text may carry command advice.
  const factSurface =
    failure &&
    [
      'notSignedIn',
      'savedConversationMissing',
      'pluginInputRequired',
      'modelUnavailable',
      'providerUnavailable',
      'providerSafetyStopped',
      'providerResponseFailed'
    ].includes(failure.kind)
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  // The host can't tell it's a WSL host; name the distro only over its plain not-installed words.
  const wslMissingSurface =
    failure?.kind === 'cliMissing' && wslDistro
      ? (['row', 'rejection'] as const).find(
          (surface) => block.text === agentSessionFailureSentence(failure, surface, { agentName })
        )
      : undefined
  const text = named
    ? nativeChatOrcaStopRowText(
        orcaStop.cause,
        machine,
        { continueAvailable, remoteHost },
        sayNativeChatOrcaStopTranslated
      )
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
      : failure && factSurface
        ? agentSessionFailureSentence(
            failure,
            factSurface,
            { agentName },
            sayAgentSessionFailureTranslated
          )
        : failure && wslMissingSurface && wslDistro
          ? agentSessionFailureSentence(
              failure,
              wslMissingSurface,
              { agentName, wslDistro },
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
        tone && toneClass(tone)
      )}
    >
      <div className="flex items-start gap-2">
        {Icon ? <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : null}
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">
          {antigravitySignInContent ?? text}
        </p>
        {continueOffered ? (
          <NativeChatInterruptedContinueButton onContinue={orcaStopView.continueNow} />
        ) : usageLimitContinue ? (
          <UsageLimitContinueNow
            resetsAt={
              failure?.kind === 'usageLimitReached'
                ? (orcaStopView.usageLimitContinueAt ?? failure.usageLimit?.resetsAt)
                : undefined
            }
          />
        ) : null}
      </div>
      {usageLimitContinue ? <NativeChatUsageLimitActions /> : null}
      {usageLimitContinue && orcaStopView.usageLimitAutoContinue ? (
        <NativeChatUsageLimitAutoContinue state={orcaStopView.usageLimitAutoContinue} />
      ) : null}
      <NativeChatSetupButton failureKind={block.failure?.kind} />
      {block.providerFrame || detail ? (
        <ProviderFrameRow
          block={block}
          detail={detail}
          summary={t('components.native-chat.notices.details', 'Details')}
        />
      ) : null}
    </div>
  )
}

// The clock subscription only invalidates the view; fresh wall time owns reset eligibility.
function UsageLimitContinueNow({
  resetsAt
}: {
  resetsAt: number | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const orcaStopView = useNativeChatOrcaStopView()
  const resetPassed = useSyncExternalStore(
    (invalidate) => {
      if (resetsAt === undefined) {
        return () => {}
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const refresh = (): void => {
        clearTimeout(timer)
        const delay = resetsAt - Date.now()
        timer = delay > 0 ? setTimeout(refresh, Math.min(delay, 2_147_483_647)) : undefined
        invalidate()
      }
      refresh()
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', refresh)
      return () => {
        clearTimeout(timer)
        window.removeEventListener('focus', refresh)
        document.removeEventListener('visibilitychange', refresh)
      }
    },
    () => resetsAt !== undefined && Date.now() >= resetsAt
  )
  if (!resetPassed) {
    return null
  }
  return (
    <NativeChatInterruptedContinueButton
      label={t('components.native-chat.usageLimitActions.continueNow', 'Continue Now')}
      onContinue={orcaStopView.continueUsageLimit}
      disabled={orcaStopView.usageLimitContinueDisabled}
      explanation={t(
        'components.native-chat.interruptedContinue.usageLimitExplanation',
        'Asks the agent to continue where it left off. Use it once the limit resets.'
      )}
    />
  )
}
