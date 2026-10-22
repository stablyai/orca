import { nativeChatAskRequiresTerminal } from '../../../../shared/native-chat-agent-support'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { ComponentProps } from 'react'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatPromptStrip } from './NativeChatPromptCollapse'
import type { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'

export function NativeChatTerminalPromptCards({
  presentation,
  cardProps
}: {
  presentation: ReturnType<typeof useNativeChatPromptCardPresentation>
  cardProps: Omit<
    ComponentProps<typeof NativeChatInteractiveCard>,
    'card' | 'onDismiss' | 'onCollapse' | 'requiresTerminal'
  > & { agent: AgentType }
}) {
  const { card, collapsedCard } = presentation
  const mounted = card ?? collapsedCard
  return (
    <>
      {mounted ? (
        <div hidden={collapsedCard !== null} inert={collapsedCard !== null} className="contents">
          <NativeChatInteractiveCard
            {...cardProps}
            requiresTerminal={nativeChatAskRequiresTerminal(cardProps.agent)}
            key={presentation.occurrenceKey ?? 'prompt'}
            card={mounted}
            onDismiss={presentation.dismiss}
            onCollapse={presentation.collapse}
          />
        </div>
      ) : null}
      {collapsedCard ? (
        <NativeChatPromptStrip card={collapsedCard} onExpand={presentation.expand} />
      ) : null}
    </>
  )
}
