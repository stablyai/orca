import { useId } from 'react'
import { Loader2 } from 'lucide-react'
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

/** The live turn's tail line: a spinner plus what the turn is doing right now —
 *  "Stopping…" once the person's Stop is ending it, else the provider's activity text, else that
 *  it is reasoning, else plain "Working…".
 *  The clock lives in the turn bar under the user's message, not here. While the
 *  agent's open reasoning block has text, the line is that block's disclosure. */
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
  const disclosure = useNativeChatDisclosure(
    reasoning ? nativeChatReasoningDisclosureKey(reasoning.message.id) : undefined,
    false
  )
  const open = reasoning !== null && disclosure.open
  const labelId = useId()

  return (
    <Collapsible open={open} onOpenChange={disclosure.setOpen}>
      {/* One element for every state of the line, so a screen reader hears each new label. The
          trigger overlays it, rather than wrapping it, and the body sits outside it. */}
      <div
        className="group/reasoning relative flex min-h-6 items-center gap-1.5 text-sm native-chat-message-text leading-relaxed text-muted-foreground"
        data-native-chat-turn-activity="true"
        data-state={open ? 'open' : 'closed'}
        aria-live="polite"
        aria-atomic="true"
      >
        <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        <span id={labelId} className="min-w-0 truncate text-foreground/85">
          {label}
        </span>
        {reasoning ? (
          <>
            <NativeChatReasoningChevron />
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-labelledby={labelId}
                className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            </CollapsibleTrigger>
          </>
        ) : null}
      </div>
      {reasoning ? (
        <CollapsibleContent>
          <NativeChatReasoningBody
            markdown={reasoning.markdown}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}
