import { BotTidyUpLine } from '@/components/bots/BotTidyUpLine'
import { nativeChatBotCard } from '../../native-chat-bot-cards'
import * as Fallback from '../../../../../../shared/native-chat/transcript/notices/claude-model-fallback'
import { Notebook } from 'lucide-react'
import { NativeChatForkedFromRow } from './NativeChatForkedFromRow'
import { NativeChatAutoReviewDenialRow } from './NativeChatAutoReviewDenialRow'
import { NativeChatEventRow } from '../events/NativeChatEventRow'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import type { useTranslate } from '@/i18n/use-translate'
import {
  AGENT_SESSION_HOST_STATUS_COPY as HOST_STATUS_COPY,
  type AgentSessionHostStatusPresentation
} from '../../../../../../shared/agent-session/view/agent-session-host-status-rows'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeLook,
  type NativeChatNoticeTone
} from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import {
  BOT_CONTEXT_NOTE_COPY,
  type BotContextChange
} from '../../../../../../shared/bots/bot-context-note'
import { NativeChatDividerRow } from '../../NativeChatDividerRow'
import * as Details from '../diagnostics/NativeChatProviderDetails'

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

const BOT_CONTEXT_WORDS: Record<BotContextChange, () => string> = {
  soul: () => translate('components.native-chat.botContext.soul', BOT_CONTEXT_NOTE_COPY.soul),
  memory: () => translate('components.native-chat.botContext.memory', BOT_CONTEXT_NOTE_COPY.memory)
}

export function toneClass(tone: NativeChatNoticeTone): string {
  return tone === 'warning'
    ? 'text-chat-warning'
    : tone === 'error'
      ? 'text-destructive'
      : 'text-chat-foreground-faint'
}

type NoticeTranslate = ReturnType<typeof useTranslate>

/** The notice rows that read only their look: static lines, cards and disclosures. Null when the
 *  block is a failure/orca-stop row the caller renders itself. */
export function nativeChatNoticeLookRow({
  block,
  messageId,
  timestamp,
  agentName,
  t
}: {
  block: NativeChatTextBlock
  messageId?: string
  timestamp?: number | null
  agentName?: string
  t: NoticeTranslate
}): React.JSX.Element | null {
  const look = nativeChatNoticeLook(block)
  if (look.kind === 'forked-from') {
    return <NativeChatForkedFromRow look={look} />
  }
  if (look.kind === 'divider') {
    const label =
      look.label === 'contextCleared'
        ? t('components.native-chat.notices.contextCleared', NATIVE_CHAT_NOTICE_COPY.contextCleared)
        : t('components.native-chat.notices.compaction', NATIVE_CHAT_NOTICE_COPY.compaction)
    return <NativeChatDividerRow label={label} />
  }
  if (look.kind === 'command-output') {
    // Why: command output is laid out in columns; proportional type breaks its grid.
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-chat-foreground">
        {block.text}
      </pre>
    )
  }
  const botCard = nativeChatBotCard(block, messageId ?? '', timestamp)
  if (botCard) {
    return botCard
  }
  if (block.tidyUp) {
    return <BotTidyUpLine note={block.tidyUp} />
  }
  if (block.botContext) {
    const { botId, changed } = block.botContext
    return (
      <NativeChatEventRow
        icon={<Notebook aria-hidden className="size-3.5" />}
        timestamp={timestamp}
      >
        <button
          type="button"
          onClick={() => openBotSettings(botId, changed.length === 1 ? changed[0] : undefined)}
          className="line-clamp-2 rounded-sm text-left hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {changed.map((change) => BOT_CONTEXT_WORDS[change]()).join(' · ')}
        </button>
      </NativeChatEventRow>
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
          Fallback.CLAUDE_MODEL_FALLBACK_COPY,
          Fallback.claudeModelFallbackLabels(look)
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
  if (look.kind === 'auto-review-denied') {
    return (
      <NativeChatAutoReviewDenialRow
        denial={look.denial}
        agent={agentName ?? look.agent}
        itemId={messageId}
      />
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
      <Details.NativeChatDetailsDisclosure summary={summary} bodyClassName={toneClass(look.tone)}>
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
      </Details.NativeChatDetailsDisclosure>
    )
  }
  return null
}
