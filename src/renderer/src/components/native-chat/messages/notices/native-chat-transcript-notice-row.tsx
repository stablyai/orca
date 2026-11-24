import { agentSessionHostStatusText } from './agent-session-host-status-text'
import { BotTidyUpLine } from '@/components/bots/BotTidyUpLine'
import { nativeChatBotCard } from '../../native-chat-bot-cards'
import * as Fallback from '../../../../../../shared/native-chat/transcript/notices/claude-model-fallback'
import { NativeChatForkedFromRow } from './NativeChatForkedFromRow'
import { NativeChatAutoReviewDenialRow } from './NativeChatAutoReviewDenialRow'
import { NativeChatEventRow } from '../events/NativeChatEventRow'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import {
  BOT_CONTEXT_NOTE_COPY,
  type BotContextChange
} from '../../../../../../shared/bots/bot-context-note'
import { NativeChatDividerRow } from '../../NativeChatDividerRow'
import { Notebook } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import {
  NATIVE_CHAT_NOTICE_COPY,
  type NativeChatNoticeLook
} from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'

const BOT_CONTEXT_WORDS: Record<BotContextChange, () => string> = {
  soul: () => translate('components.native-chat.botContext.soul', BOT_CONTEXT_NOTE_COPY.soul),
  memory: () => translate('components.native-chat.botContext.memory', BOT_CONTEXT_NOTE_COPY.memory)
}

export function nativeChatTranscriptNoticeRow({
  block,
  look,
  messageId,
  timestamp,
  agentName,
  t
}: {
  block: NativeChatTextBlock
  look: NativeChatNoticeLook
  messageId?: string
  timestamp: number | null
  agentName?: string
  t: Translate
}): React.JSX.Element | null {
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
          className="truncate rounded-sm text-left hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {changed.map((change) => BOT_CONTEXT_WORDS[change]()).join(' · ')}
        </button>
      </NativeChatEventRow>
    )
  }
  if (look.kind === 'host-status') {
    if (look.presentation === 'continued-outside-recent') {
      return <NativeChatDividerRow label={agentSessionHostStatusText(look.presentation)} />
    }
    return (
      <p className="min-w-0 max-w-full select-text text-sm text-chat-foreground-faint [overflow-wrap:anywhere]">
        {agentSessionHostStatusText(look.presentation)}
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
  return null
}
