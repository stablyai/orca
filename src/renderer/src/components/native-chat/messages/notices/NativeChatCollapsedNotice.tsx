import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { agentSessionFailureDetailText } from '../../../../../../shared/agent-session/failures/agent-session-failure-quoted-detail'
import { readWholeAgentSessionFailureFact } from '../../../../../../shared/agent-session/failures/agent-session-failure'
import type { NativeChatNoticeLook } from '../../../../../../shared/native-chat/native-chat-notice'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatDetailsDisclosure } from '../diagnostics/NativeChatProviderDetails'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'

type CollapsedNoticeLook = Extract<NativeChatNoticeLook, { kind: 'collapsed-notice' }>

function collapsedNoticeSummary(look: CollapsedNoticeLook, t: Translate): string {
  const counts =
    look.attempt && look.maxRetries ? { attempt: look.attempt, max: look.maxRetries } : undefined
  switch (look.label) {
    case 'retrying':
      return counts
        ? t(
            'components.native-chat.notices.retryingCount',
            'Retrying ({{attempt}} of {{max}}). View details.',
            counts
          )
        : t('components.native-chat.notices.retrying', 'Retrying. View details.')
    case 'rate-limited':
      return counts
        ? t(
            'components.native-chat.notices.rateLimitedRetryingCount',
            'Rate limited, retrying ({{attempt}} of {{max}}). View details.',
            counts
          )
        : t(
            'components.native-chat.notices.rateLimitedRetrying',
            'Rate limited, retrying. View details.'
          )
    case 'configuration':
      return t(
        'components.native-chat.notices.codexConfigurationWarning',
        'Codex configuration warning. View details.'
      )
    case 'deprecation':
      return t(
        'components.native-chat.notices.codexDeprecationNotice',
        'Codex deprecation notice. View details.'
      )
  }
}

/** A retry or Codex configuration/deprecation notice: one summary line that opens the host's own text. */
export function NativeChatCollapsedNotice({
  block,
  look,
  disclosureKeys
}: {
  block: NativeChatTextBlock
  look: CollapsedNoticeLook
  /** Where the open choice is kept, newest first. */
  disclosureKeys?: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  const disclosure = useNativeChatDisclosure(disclosureKeys?.[0], false, disclosureKeys)
  const payload = block.providerFrame?.payload
  const failureDetail = agentSessionFailureDetailText(
    readWholeAgentSessionFailureFact(block.failure)
  )
  const detail =
    failureDetail && !block.text.trim().includes(failureDetail.trim()) ? failureDetail : undefined
  return (
    <NativeChatDetailsDisclosure
      summary={collapsedNoticeSummary(look, t)}
      bodyAs="div"
      summaryClassName={
        look.label === 'configuration'
          ? // Square left corners keep the rule a straight line.
            '-ml-0.5 rounded-l-none border-l-2 border-chat-warning'
          : undefined
      }
      // The payload scrolls on its own, so the box around it does not.
      bodyClassName={cn(
        'font-sans text-sm [overflow-wrap:anywhere]',
        payload && 'max-h-none overflow-visible'
      )}
      open={disclosure.open}
      onOpenChange={disclosure.setOpen}
    >
      {block.text}
      {detail ? `\n\n${detail}` : ''}
      {payload ? (
        <>
          <span className="mt-2 block text-xs text-muted-foreground">
            {t('components.native-chat.notices.providerResponse', 'Provider response')}
          </span>
          <span className="scrollbar-sleek mt-1 block max-h-60 overflow-y-auto font-mono text-chat-code">
            {payload.truncated
              ? `${t(
                  'components.native-chat.notices.truncatedResponse',
                  'Provider response truncated (original size: {{bytes}} bytes).',
                  { bytes: payload.byteLength }
                )}\n`
              : ''}
            {payload.head}
          </span>
        </>
      ) : null}
    </NativeChatDetailsDisclosure>
  )
}
