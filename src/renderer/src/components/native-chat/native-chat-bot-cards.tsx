import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
// The cards a bot's chat draws in place of a status line: offers, import plans, setup cards, requests.
import type { NativeChatTextBlock } from '../../../../shared/native-chat/native-chat-types'
import {
  nativeChatBotCardOf,
  type NativeChatMessageBotCard
} from '../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'

const NativeChatBotBlockCardSurface = lazy(() =>
  import('./NativeChatBotCardSurface').then((module) => ({
    default: module.NativeChatBotBlockCardSurface
  }))
)

const NativeChatMessageBotCardSurface = lazy(() =>
  import('./NativeChatBotCardSurface').then((module) => ({
    default: module.NativeChatMessageBotCardSurface
  }))
)

/** The card for a status line that carries one, or null. */
export function nativeChatBotCard(
  block: NativeChatTextBlock,
  messageId: string,
  timestamp: number | null = null
): React.JSX.Element | null {
  const card = nativeChatBotCardOf(block)
  if (!card) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <NativeChatBotBlockCardSurface
        card={card}
        context={{ messageId, timestamp, fallback: block.text }}
      />
    </Suspense>
  )
}

/** The card a whole message is drawn as. */
export function nativeChatMessageBotCard(
  card: NativeChatMessageBotCard,
  timestamp: number | null
): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <NativeChatMessageBotCardSurface card={card} timestamp={timestamp} />
    </Suspense>
  )
}
