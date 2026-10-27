import { useId } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatLiveLine } from '../../../../shared/native-chat-live-line'
import { nativeChatReasoningDisclosureKey } from '../../../../shared/native-chat-reasoning-row'
import {
  describeNativeChatActiveTurnLabel,
  type NativeChatActiveTurnLabel
} from '../../../../shared/native-chat-turn-status'
import {
  NativeChatReasoningBody,
  NativeChatReasoningChevron
} from './NativeChatReasoningDisclosure'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { LoadingSpinner } from '@/components/LoadingSpinner'

// Literal keys with literal fallbacks: a dynamic key registers no catalog reference.
function statusLabel(key: Extract<NativeChatActiveTurnLabel, { source: 'status' }>['key']): string {
  switch (key) {
    case 'thinking':
      return translate('components.native-chat.status.thinking', 'Thinking')
    case 'stopping':
      return translate('components.native-chat.status.stopping', 'Stopping…')
    case 'working':
      return translate('components.native-chat.status.working', 'Working…')
  }
}

/** Keep the clock in the turn bar; this tail shows activity or discloses open reasoning. */
export function NativeChatTurnActivityLine({
  line,
  onLinkClick,
  allowFileUriLinks
}: {
  line: NativeChatLiveLine
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element {
  const resolved = describeNativeChatActiveTurnLabel(line)
  const label = resolved.source === 'activity' ? resolved.text : statusLabel(resolved.key)
  const { reasoning } = line
  // The finished row reads this key too, so a block opened here lands open once it ends.
  const disclosureKey = reasoning
    ? nativeChatReasoningDisclosureKey(reasoning.message.id)
    : undefined
  const disclosure = useNativeChatDisclosure(disclosureKey, false)
  const open = reasoning !== null && disclosure.open
  const labelId = useId()

  return (
    <Collapsible open={open} onOpenChange={disclosure.setOpen}>
      {/* Keep one live region so label changes announce; overlay its trigger and place reasoning outside it. */}
      <div
        className="group/reasoning relative flex min-h-6 items-center gap-1.5 text-sm leading-relaxed text-chat-foreground-faint"
        data-native-chat-turn-activity="true"
        data-state={open ? 'open' : 'closed'}
        aria-live="polite"
        aria-atomic="true"
      >
        <LoadingSpinner className="size-4 shrink-0" />
        <span id={labelId} className="min-w-0 truncate text-chat-foreground">
          {label}
        </span>
        {reasoning ? (
          <>
            <NativeChatReasoningChevron />
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-labelledby={labelId}
                className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            </CollapsibleTrigger>
          </>
        ) : null}
      </div>
      {reasoning ? (
        <CollapsibleContent>
          <NativeChatReasoningBody
            rowKey={disclosureKey}
            markdown={reasoning.markdown}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
            streaming
          />
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}
